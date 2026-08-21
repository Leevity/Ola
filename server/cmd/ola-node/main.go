package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ola-remote-server/internal/meshclient"
)

type capabilitiesFlag []meshclient.Capability

func (value *capabilitiesFlag) String() string { return fmt.Sprint(*value) }

func (value *capabilitiesFlag) Set(raw string) error {
	parts := strings.Split(raw, ":")
	if len(parts) != 2 || parts[0] == "" || (parts[1] != "low" && parts[1] != "medium" && parts[1] != "high") {
		return fmt.Errorf("capability must use id:risk, with risk low|medium|high")
	}
	*value = append(*value, meshclient.Capability{ID: parts[0], Risk: parts[1], Version: "1"})
	return nil
}

func main() {
	var apiURL, token, deviceID, statePath, version string
	var watch bool
	var enableShell bool
	var capabilities capabilitiesFlag
	defaultState := filepath.Join(userHome(), ".ola", "node-identity.json")
	flag.StringVar(&apiURL, "api", envOr("OLA_API_URL", "https://localhost:7300"), "Ola control plane URL")
	flag.StringVar(&token, "token", os.Getenv("OLA_TOKEN"), "Ola account bearer token")
	flag.StringVar(&deviceID, "device-id", os.Getenv("OLA_DEVICE_ID"), "registered device ID")
	flag.StringVar(&statePath, "state", defaultState, "node identity file")
	flag.StringVar(&version, "version", "0.1.0", "ola-node runtime version")
	flag.Var(&capabilities, "capability", "capability id:risk; repeatable")
	flag.BoolVar(&watch, "watch", false, "poll target events until interrupted")
	flag.BoolVar(&enableShell, "enable-shell", false, "enable explicitly declared terminal.execute events")
	flag.Parse()
	if token == "" || deviceID == "" {
		fatal("-token/OLA_TOKEN and -device-id/OLA_DEVICE_ID are required")
	}
	if len(capabilities) == 0 {
		capabilities = capabilitiesFlag{{ID: "mesh.event.receive", Risk: "low", Version: "1"}, {ID: "system.info", Risk: "low", Version: "1"}}
	}
	identity, err := meshclient.LoadOrCreateIdentity(statePath)
	if err != nil {
		fatal(err.Error())
	}
	client := meshclient.Client{BaseURL: apiURL, Token: token}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	node, err := client.Register(ctx, identity, deviceID, "linux", "ola-node", version, capabilities)
	if err != nil {
		fatal(err.Error())
	}
	printJSON(node)
	if !watch {
		return
	}

	var after int64
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := client.Heartbeat(ctx, node.NodeID); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		if events, err := client.ListEvents(ctx, node.NodeID, after); err != nil {
			fmt.Fprintln(os.Stderr, err)
		} else {
			for _, event := range events {
				if enableShell && event.Type == "task.command" {
					if err := handleCommand(ctx, client, node, event); err != nil {
						fmt.Fprintln(os.Stderr, err)
					}
				} else {
					printJSON(event)
				}
				if event.Sequence > after {
					after = event.Sequence
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func handleCommand(ctx context.Context, client meshclient.Client, node meshclient.Node, event meshclient.Event) error {
	if err := client.VerifyDeliveryTicket(ctx, event.Ticket, event.SubjectNodeID, node.NodeID, event.SessionID, "terminal.execute"); err != nil {
		return err
	}
	var command struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(event.Payload, &command); err != nil || strings.TrimSpace(command.Command) == "" || len(command.Command) > 4096 {
		return fmt.Errorf("invalid task.command payload")
	}
	ticket, err := client.IssueTicket(ctx, node.NodeID, event.SubjectNodeID, event.SessionID, []string{"mesh.event.receive"})
	if err != nil {
		return err
	}
	sequence := nextResponseSequence(ctx, client, event.SubjectNodeID, event.SessionID)
	if _, err := client.PublishEvent(ctx, ticket, meshclient.Event{EventID: "event-started-" + event.EventID, SubjectNodeID: node.NodeID, TargetNodeID: event.SubjectNodeID, SessionID: event.SessionID, Sequence: sequence, Type: "task.started", Payload: json.RawMessage(`{"node":"ola-node"}`)}); err != nil {
		return err
	}
	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	commandRun := exec.CommandContext(runCtx, "/bin/sh", "-c", command.Command)
	var output bytes.Buffer
	commandRun.Stdout = &output
	commandRun.Stderr = &output
	runErr := commandRun.Run()
	text := output.String()
	if len(text) > 16<<10 {
		text = text[:16<<10]
	}
	payload, _ := json.Marshal(map[string]string{"output": text})
	eventType := "task.completed"
	if runErr != nil {
		eventType = "task.failed"
	}
	_, publishErr := client.PublishEvent(ctx, ticket, meshclient.Event{EventID: "event-result-" + event.EventID, SubjectNodeID: node.NodeID, TargetNodeID: event.SubjectNodeID, SessionID: event.SessionID, Sequence: sequence + 1, Type: eventType, Payload: payload})
	if publishErr != nil {
		return publishErr
	}
	if runErr != nil {
		return fmt.Errorf("command failed: %w", runErr)
	}
	return nil
}

func nextResponseSequence(ctx context.Context, client meshclient.Client, targetNodeID, sessionID string) int64 {
	events, err := client.ListEvents(ctx, targetNodeID, 0)
	if err != nil {
		return 1
	}
	var highest int64
	for _, event := range events {
		if event.SessionID == sessionID && event.Sequence > highest {
			highest = event.Sequence
		}
	}
	return highest + 1
}

func userHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}
func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func printJSON(value any)  { encoded, _ := json.Marshal(value); fmt.Println(string(encoded)) }
func fatal(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }

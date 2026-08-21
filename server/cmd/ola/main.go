package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"ola-remote-server/internal/meshclient"
)

func main() {
	if len(os.Args) < 3 || os.Args[1] != "mesh" {
		usage()
		return
	}
	command := os.Args[2]
	flags := flag.NewFlagSet("ola mesh "+command, flag.ExitOnError)
	apiURL := flags.String("api", envOr("OLA_API_URL", "https://localhost:7300"), "Ola control plane URL")
	token := flags.String("token", os.Getenv("OLA_TOKEN"), "Ola account bearer token")
	nodeID := flags.String("node", "", "Mesh node ID")
	subjectNodeID := flags.String("subject", "", "controller/source Mesh node ID")
	targetNodeID := flags.String("target", "", "target Mesh node ID")
	sessionID := flags.String("session", "", "Mesh session ID")
	commandText := flags.String("command", "", "terminal command")
	capability := flags.String("capability", "terminal.execute", "required target capability")
	sequence := flags.Int64("sequence", 1, "task event sequence")
	after := flags.Int64("after", 0, "event cursor")
	flags.Parse(os.Args[3:])
	if *token == "" {
		fail("-token/OLA_TOKEN is required")
	}
	client := meshclient.Client{BaseURL: *apiURL, Token: *token}
	ctx := context.Background()
	switch command {
	case "nodes":
		nodes, err := client.ListNodes(ctx)
		if err != nil {
			fail(err.Error())
		}
		printJSON(nodes)
	case "heartbeat":
		if *nodeID == "" {
			fail("-node is required")
		}
		node, err := client.Heartbeat(ctx, *nodeID)
		if err != nil {
			fail(err.Error())
		}
		printJSON(node)
	case "events":
		if *nodeID == "" {
			fail("-node is required")
		}
		events, err := client.ListEvents(ctx, *nodeID, *after)
		if err != nil {
			fail(err.Error())
		}
		printJSON(events)
	case "command":
		if *subjectNodeID == "" || *targetNodeID == "" || *sessionID == "" || *commandText == "" {
			fail("-subject, -target, -session and -command are required")
		}
		ticket, err := client.IssueTicket(ctx, *subjectNodeID, *targetNodeID, *sessionID, []string{*capability})
		if err != nil {
			fail(err.Error())
		}
		payload, _ := json.Marshal(map[string]string{"command": *commandText})
		if *sequence < 1 || *sequence > 1_000_000 {
			fail("-sequence must be between 1 and 1000000")
		}
		event, err := client.PublishEvent(ctx, ticket, meshclient.Event{EventID: fmt.Sprintf("cmd-%d", time.Now().UnixNano()), SubjectNodeID: *subjectNodeID, TargetNodeID: *targetNodeID, SessionID: *sessionID, Sequence: *sequence, Type: "task.command", Payload: payload})
		if err != nil {
			fail(err.Error())
		}
		printJSON(event)
	default:
		usage()
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func printJSON(value any) {
	encoded, _ := json.MarshalIndent(value, "", "  ")
	fmt.Println(string(encoded))
}
func fail(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }
func usage()              { fmt.Fprintln(os.Stderr, "usage: ola mesh nodes|heartbeat|events [flags]") }

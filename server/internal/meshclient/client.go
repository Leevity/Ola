package meshclient

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ola-remote-server/internal/auth"
)

const protocolVersion = "v0alpha1"

type Capability struct {
	ID      string `json:"id"`
	Risk    string `json:"risk"`
	Version string `json:"version,omitempty"`
}

type Node struct {
	NodeID          string       `json:"nodeId"`
	DeviceID        string       `json:"deviceId"`
	Platform        string       `json:"platform"`
	Runtime         string       `json:"runtime"`
	RuntimeVersion  string       `json:"runtimeVersion"`
	PublicKey       string       `json:"publicKey"`
	Capabilities    []Capability `json:"capabilities"`
	ManifestVersion int64        `json:"manifestVersion"`
	CreatedAt       time.Time    `json:"createdAt"`
	UpdatedAt       time.Time    `json:"updatedAt"`
}

type Event struct {
	EventID       string          `json:"eventId"`
	SubjectNodeID string          `json:"subjectNodeId"`
	TargetNodeID  string          `json:"targetNodeId"`
	SessionID     string          `json:"sessionId"`
	Sequence      int64           `json:"sequence"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	Capabilities  []string        `json:"capabilities,omitempty"`
	Ticket        string          `json:"ticket,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
}

type Identity struct {
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
}

func LoadOrCreateIdentity(path string) (Identity, error) {
	if path == "" {
		return Identity{}, errors.New("mesh identity path is required")
	}
	bytes, err := os.ReadFile(path)
	if err == nil {
		var stored struct {
			PrivateKey string `json:"privateKey"`
		}
		if json.Unmarshal(bytes, &stored) != nil {
			return Identity{}, errors.New("invalid mesh identity file")
		}
		key, decodeErr := base64.RawURLEncoding.DecodeString(stored.PrivateKey)
		if decodeErr != nil || len(key) != ed25519.PrivateKeySize {
			return Identity{}, errors.New("invalid mesh private key")
		}
		privateKey := ed25519.PrivateKey(key)
		return Identity{PrivateKey: privateKey, PublicKey: privateKey.Public().(ed25519.PublicKey)}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Identity{}, err
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return Identity{}, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(privateKey)
	contents, _ := json.Marshal(struct {
		Version    string `json:"version"`
		PrivateKey string `json:"privateKey"`
	}{protocolVersion, encoded})
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, contents, 0600); err != nil {
		return Identity{}, err
	}
	if err := os.Chmod(temporary, 0600); err != nil {
		return Identity{}, err
	}
	if err := os.Rename(temporary, path); err != nil {
		return Identity{}, err
	}
	return Identity{PrivateKey: privateKey, PublicKey: publicKey}, nil
}

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c Client) request(ctx context.Context, method, path string, input any, output any) error {
	base := strings.TrimRight(c.BaseURL, "/")
	u, err := url.Parse(base + path)
	if err != nil || u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "localhost") {
		return errors.New("mesh control plane must use HTTPS except localhost development")
	}
	var body io.Reader
	if input != nil {
		encoded, marshalErr := json.Marshal(input)
		if marshalErr != nil {
			return marshalErr
		}
		body = strings.NewReader(string(encoded))
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token == "" || len(c.Token) > 4096 {
		return errors.New("mesh bearer token is required")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var message struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(responseBody, &message)
		if message.Error == "" {
			message.Error = response.Status
		}
		return fmt.Errorf("mesh API: %s", message.Error)
	}
	if output != nil && len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, output); err != nil {
			return fmt.Errorf("mesh API returned invalid JSON: %w", err)
		}
	}
	return nil
}

func (c Client) Register(ctx context.Context, identity Identity, deviceID, platform, runtime, runtimeVersion string, capabilities []Capability) (Node, error) {
	publicKey := base64.RawURLEncoding.EncodeToString(identity.PublicKey)
	manifest := struct {
		DeviceID       string       `json:"deviceId"`
		Platform       string       `json:"platform"`
		Runtime        string       `json:"runtime"`
		RuntimeVersion string       `json:"runtimeVersion"`
		PublicKey      string       `json:"publicKey"`
		Capabilities   []Capability `json:"capabilities"`
	}{deviceID, platform, runtime, runtimeVersion, publicKey, capabilities}
	canonical, err := json.Marshal(manifest)
	if err != nil {
		return Node{}, err
	}
	digest := sha256.Sum256(canonical)
	proof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(identity.PrivateKey, digest[:]))
	request := struct {
		DeviceID       string       `json:"deviceId"`
		Platform       string       `json:"platform"`
		Runtime        string       `json:"runtime"`
		RuntimeVersion string       `json:"runtimeVersion"`
		PublicKey      string       `json:"publicKey"`
		Capabilities   []Capability `json:"capabilities"`
		Proof          string       `json:"proof"`
	}{deviceID, platform, runtime, runtimeVersion, publicKey, capabilities, proof}
	var result struct {
		Node Node `json:"node"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/mesh/v1/nodes/register", request, &result); err != nil {
		return Node{}, err
	}
	return result.Node, nil
}

func (c Client) ListNodes(ctx context.Context) ([]Node, error) {
	var result struct {
		Nodes []Node `json:"nodes"`
	}
	if err := c.request(ctx, http.MethodGet, "/api/mesh/v1/nodes", nil, &result); err != nil {
		return nil, err
	}
	return result.Nodes, nil
}

func (c Client) Heartbeat(ctx context.Context, nodeID string) (Node, error) {
	var result struct {
		Node Node `json:"node"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/mesh/v1/nodes/"+url.PathEscape(nodeID)+"/heartbeat", map[string]any{}, &result); err != nil {
		return Node{}, err
	}
	return result.Node, nil
}

func (c Client) IssueTicket(ctx context.Context, subjectNodeID, targetNodeID, sessionID string, capabilities []string) (string, error) {
	var result struct {
		Ticket string `json:"ticket"`
	}
	request := map[string]any{"subjectNodeId": subjectNodeID, "targetNodeId": targetNodeID, "sessionId": sessionID, "capabilities": capabilities}
	if err := c.request(ctx, http.MethodPost, "/api/mesh/v1/capability-tickets", request, &result); err != nil {
		return "", err
	}
	if result.Ticket == "" {
		return "", errors.New("mesh control plane returned an empty ticket")
	}
	return result.Ticket, nil
}

func (c Client) PublishEvent(ctx context.Context, ticket string, event Event) (Event, error) {
	request := struct {
		Ticket        string          `json:"ticket"`
		EventID       string          `json:"eventId"`
		SubjectNodeID string          `json:"subjectNodeId"`
		TargetNodeID  string          `json:"targetNodeId"`
		SessionID     string          `json:"sessionId"`
		Sequence      int64           `json:"sequence"`
		Type          string          `json:"type"`
		Payload       json.RawMessage `json:"payload"`
	}{ticket, event.EventID, event.SubjectNodeID, event.TargetNodeID, event.SessionID, event.Sequence, event.Type, event.Payload}
	var result struct {
		Event Event `json:"event"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/mesh/v1/events", request, &result); err != nil {
		return Event{}, err
	}
	return result.Event, nil
}

func (c Client) ListEvents(ctx context.Context, targetNodeID string, after int64) ([]Event, error) {
	query := url.Values{}
	query.Set("targetNodeId", targetNodeID)
	query.Set("after", fmt.Sprintf("%d", after))
	var result struct {
		Events []Event `json:"events"`
	}
	if err := c.request(ctx, http.MethodGet, "/api/mesh/v1/events?"+query.Encode(), nil, &result); err != nil {
		return nil, err
	}
	return result.Events, nil
}

func (c Client) VerifyDeliveryTicket(ctx context.Context, ticket, subjectNodeID, targetNodeID, sessionID, capability string) error {
	base := strings.TrimRight(c.BaseURL, "/")
	u, err := url.Parse(base + "/api/mesh/v1/control-plane-key")
	if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "localhost")) {
		return errors.New("mesh control plane must use HTTPS except localhost development")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("mesh control-plane key: %s", response.Status)
	}
	var key struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&key); err != nil {
		return err
	}
	claims, err := auth.ParseMeshCapabilityTicket(key.PublicKey, ticket)
	if err != nil || claims.SubjectNodeID != subjectNodeID || claims.TargetNodeID != targetNodeID || claims.SessionID != sessionID {
		return errors.New("mesh delivery ticket is not bound to this event")
	}
	for _, item := range claims.Capabilities {
		if item == capability {
			return nil
		}
	}
	return errors.New("mesh delivery ticket does not grant the requested capability")
}

func ParsePrivateKeyPEM(privateKey []byte) (ed25519.PrivateKey, error) {
	parsed, err := x509.ParsePKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("not an Ed25519 private key")
	}
	return key, nil
}

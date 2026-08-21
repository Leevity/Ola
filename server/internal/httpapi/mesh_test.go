package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"ola-remote-server/internal/auth"
	"ola-remote-server/internal/store"
)

type meshRegistrationPayload struct {
	DeviceID       string              `json:"deviceId"`
	Platform       string              `json:"platform"`
	Runtime        string              `json:"runtime"`
	RuntimeVersion string              `json:"runtimeVersion"`
	PublicKey      string              `json:"publicKey"`
	Capabilities   []map[string]string `json:"capabilities"`
}

func meshRegistration(t *testing.T, deviceID, platform string, capabilities []map[string]string) map[string]any {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encodedPublicKey := base64.RawURLEncoding.EncodeToString(publicKey)
	payload := meshRegistrationPayload{
		DeviceID: deviceID, Platform: platform, Runtime: "ola-node", RuntimeVersion: "0.1.0",
		PublicKey: encodedPublicKey, Capabilities: capabilities,
	}
	canonical, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	return map[string]any{
		"deviceId": deviceID, "platform": platform, "runtime": "ola-node", "runtimeVersion": "0.1.0",
		"publicKey": encodedPublicKey, "capabilities": capabilities,
		"proof": base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:])),
	}
}

func registerMeshNode(t *testing.T, handler http.Handler, token, deviceID, platform string, capabilities []map[string]string) string {
	t.Helper()
	result := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/nodes/register", meshRegistration(t, deviceID, platform, capabilities), token)
	if result["_status"] != float64(http.StatusOK) {
		t.Fatalf("mesh node registration failed: %#v", result)
	}
	node, _ := result["node"].(map[string]any)
	nodeID, _ := node["nodeId"].(string)
	if nodeID == "" {
		t.Fatalf("mesh node ID missing: %#v", result)
	}
	return nodeID
}

func TestMeshNodeRegistrationIsAccountScopedAndValidatesManifest(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	tokenA, deviceA := registerAccountAndDevice(t, handler, "mesh-a@example.com")
	tokenB, _ := registerAccountAndDevice(t, handler, "mesh-b@example.com")

	foreign := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/nodes/register", meshRegistration(t, deviceA, "android", []map[string]string{}), tokenB)
	if foreign["_status"] != float64(http.StatusNotFound) {
		t.Fatalf("foreign user must not register another account device: %#v", foreign)
	}

	invalid := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/nodes/register", map[string]any{
		"deviceId": deviceA, "platform": "android", "runtime": "ola-mobile", "runtimeVersion": "0.1.0",
		"publicKey": "not-a-key", "capabilities": []map[string]string{{"id": "invalid", "risk": "low"}},
	}, tokenA)
	if invalid["_status"] != float64(http.StatusBadRequest) {
		t.Fatalf("invalid key and capability manifest must be rejected: %#v", invalid)
	}

	nodeID := registerMeshNode(t, handler, tokenA, deviceA, "android", []map[string]string{{"id": "mobile.camera.capture", "risk": "medium"}})
	listed := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/nodes", nil, tokenA)
	nodes, _ := listed["nodes"].([]any)
	if listed["_status"] != float64(http.StatusOK) || len(nodes) != 1 {
		t.Fatalf("owner should see their registered node: %#v", listed)
	}
	foreignList := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/nodes", nil, tokenB)
	foreignNodes, _ := foreignList["nodes"].([]any)
	if foreignList["_status"] != float64(http.StatusOK) || len(foreignNodes) != 0 {
		t.Fatalf("nodes must be account-scoped: %#v", foreignList)
	}
	if nodeID == "" {
		t.Fatal("node ID should be non-empty")
	}
}

func TestMeshCapabilityTicketIsBoundToOwnedNodesAndTargetCapabilities(t *testing.T) {
	config := testConfig()
	config.JWTSecret = "mesh-ticket-test-secret-with-sufficient-length"
	handler := NewRouter(config, store.NewMemoryStore(), nil)
	token, phoneDevice := registerAccountAndDevice(t, handler, "mesh-owner@example.com")
	desktopRegistration := requestJSON(t, handler, http.MethodPost, "/api/devices/register", map[string]any{
		"deviceName": "Desktop device", "platform": "windows", "fingerprint": "mesh-owner-desktop",
	}, token)
	desktop, _ := desktopRegistration["device"].(map[string]any)
	desktopDevice, _ := desktop["id"].(string)
	if desktopRegistration["_status"] != float64(http.StatusOK) || desktopDevice == "" {
		t.Fatalf("second device registration failed: %#v", desktopRegistration)
	}
	phoneNode := registerMeshNode(t, handler, token, phoneDevice, "android", []map[string]string{{"id": "mobile.camera.capture", "risk": "medium"}})
	desktopNode := registerMeshNode(t, handler, token, desktopDevice, "windows", []map[string]string{{"id": "agent.run.readonly", "risk": "low"}})

	issued := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/capability-tickets", map[string]any{
		"subjectNodeId": phoneNode, "targetNodeId": desktopNode, "sessionId": "session-1",
		"capabilities": []string{"agent.run.readonly"},
	}, token)
	ticket, _ := issued["ticket"].(string)
	if issued["_status"] != float64(http.StatusOK) || ticket == "" || issued["ticketFingerprint"] == ticket {
		t.Fatalf("expected a bounded signed ticket without exposing its contents in audit field: %#v", issued)
	}
	key := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/control-plane-key", nil, "")
	publicKey, _ := key["publicKey"].(string)
	claims, err := auth.ParseMeshCapabilityTicket(publicKey, ticket)
	if err != nil || claims.SubjectNodeID != phoneNode || claims.TargetNodeID != desktopNode || claims.SessionID != "session-1" {
		t.Fatalf("unexpected signed ticket: claims=%#v err=%v", claims, err)
	}

	deniedCapability := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/capability-tickets", map[string]any{
		"subjectNodeId": phoneNode, "targetNodeId": desktopNode, "sessionId": "session-2",
		"capabilities": []string{"mobile.camera.capture"},
	}, token)
	if deniedCapability["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("ticket must not grant a capability absent from target manifest: %#v", deniedCapability)
	}
}

func TestMeshNodeRegistrationRejectsTamperedProof(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	token, deviceID := registerAccountAndDevice(t, handler, "mesh-proof@example.com")
	registration := meshRegistration(t, deviceID, "android", []map[string]string{{"id": "mobile.camera.capture", "risk": "medium"}})
	registration["runtimeVersion"] = "tampered"
	result := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/nodes/register", registration, token)
	if result["_status"] != float64(http.StatusBadRequest) {
		t.Fatalf("changed manifest must invalidate proof: %#v", result)
	}
}

func TestMeshTaskEventsRequireBoundTicketAndAdvanceSequence(t *testing.T) {
	config := testConfig()
	config.JWTSecret = "mesh-event-test-secret-with-sufficient-length"
	handler := NewRouter(config, store.NewMemoryStore(), nil)
	token, sourceDevice := registerAccountAndDevice(t, handler, "mesh-event@example.com")
	targetRegistration := requestJSON(t, handler, http.MethodPost, "/api/devices/register", map[string]any{
		"deviceName": "Target", "platform": "windows", "fingerprint": "mesh-event-target",
	}, token)
	targetDevice, _ := targetRegistration["device"].(map[string]any)
	targetDeviceID, _ := targetDevice["id"].(string)
	sourceNode := registerMeshNode(t, handler, token, sourceDevice, "android", []map[string]string{{"id": "task.execute", "risk": "high"}})
	targetNode := registerMeshNode(t, handler, token, targetDeviceID, "windows", []map[string]string{{"id": "task.execute", "risk": "high"}})
	ticketResponse := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/capability-tickets", map[string]any{
		"subjectNodeId": sourceNode, "targetNodeId": targetNode, "sessionId": "mesh-session-1",
		"capabilities": []string{"task.execute"},
	}, token)
	ticket, _ := ticketResponse["ticket"].(string)
	if ticketResponse["_status"] != float64(http.StatusOK) || ticket == "" {
		t.Fatalf("ticket issue failed: %#v", ticketResponse)
	}
	event := func(sequence int, eventID string, target string) map[string]any {
		return requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/events", map[string]any{
			"ticket": ticket, "eventId": eventID, "subjectNodeId": sourceNode, "targetNodeId": target,
			"sessionId": "mesh-session-1", "sequence": sequence, "type": "task.command",
			"payload": map[string]any{"command": "run"},
		}, token)
	}
	accepted := event(1, "event-1", targetNode)
	if accepted["_status"] != float64(http.StatusAccepted) {
		t.Fatalf("event should be accepted: %#v", accepted)
	}
	listed := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/events?targetNodeId="+targetNode+"&after=0", nil, token)
	events, _ := listed["events"].([]any)
	if listed["_status"] != float64(http.StatusOK) || len(events) != 1 {
		t.Fatalf("target should receive one event: %#v", listed)
	}
	delivery, _ := events[0].(map[string]any)
	deliveryTicket, _ := delivery["ticket"].(string)
	controlKey := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/control-plane-key", nil, "")
	controlPublicKey, _ := controlKey["publicKey"].(string)
	deliveryClaims, deliveryErr := auth.ParseMeshCapabilityTicket(controlPublicKey, deliveryTicket)
	if deliveryErr != nil || deliveryClaims.SubjectNodeID != sourceNode || deliveryClaims.TargetNodeID != targetNode || deliveryClaims.SessionID != "mesh-session-1" {
		t.Fatalf("delivery ticket must be bound to event: claims=%#v err=%v", deliveryClaims, deliveryErr)
	}
	conflict := event(1, "event-2", targetNode)
	if conflict["_status"] != float64(http.StatusConflict) {
		t.Fatalf("sequence replay should be rejected: %#v", conflict)
	}
	foreignTarget := event(2, "event-3", "node-not-owned")
	if foreignTarget["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("ticket target substitution should be rejected: %#v", foreignTarget)
	}
}

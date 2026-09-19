package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

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

var meshTestPrivateKeys = map[string]ed25519.PrivateKey{}

func TestMeshStatusPayloadRejectsNestedAndSensitiveValues(t *testing.T) {
	if !validMeshEventPayload(json.RawMessage(`{"node":"desktop","progress":50,"done":false}`)) {
		t.Fatal("bounded scalar status payload should be accepted")
	}
	for _, payload := range []json.RawMessage{
		json.RawMessage(`{"credentials":{"token":"secret"}}`),
		json.RawMessage(`{"detail":"Authorization: Bearer secret"}`),
		json.RawMessage(`{"items":["not status"]}`),
	} {
		if validMeshEventPayload(payload) {
			t.Fatalf("unsafe Mesh status payload was accepted: %s", payload)
		}
	}
}

func meshRegistration(t *testing.T, deviceID, platform string, capabilities []map[string]string) map[string]any {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	meshTestPrivateKeys[deviceID] = privateKey
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

func signedMeshEvent(t *testing.T, deviceID string, eventID string, subjectNodeID string, targetNodeID string, sessionID string, sequence int, eventType string, payload map[string]any) string {
	t.Helper()
	privateKey := meshTestPrivateKeys[deviceID]
	if len(privateKey) != ed25519.PrivateKeySize {
		t.Fatalf("missing Mesh private key for device %s", deviceID)
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(meshEventSigningBytes(eventID, subjectNodeID, targetNodeID, sessionID, int64(sequence), eventType, payloadBytes))
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:]))
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
	highRisk := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/nodes/register", meshRegistration(t, deviceA, "android", []map[string]string{{"id": "task.execute", "risk": "high"}}), tokenA)
	if highRisk["_status"] != float64(http.StatusBadRequest) {
		t.Fatalf("status-only Mesh must reject execution capabilities: %#v", highRisk)
	}

	nodeID := registerMeshNode(t, handler, tokenA, deviceA, "android", []map[string]string{{"id": "mesh.event.receive", "risk": "low"}})
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
	phoneNode := registerMeshNode(t, handler, token, phoneDevice, "android", []map[string]string{{"id": "mesh.event.receive", "risk": "low"}})
	desktopNode := registerMeshNode(t, handler, token, desktopDevice, "windows", []map[string]string{{"id": "system.info", "risk": "low"}})

	issued := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/capability-tickets", map[string]any{
		"subjectNodeId": phoneNode, "targetNodeId": desktopNode, "sessionId": "session-1",
		"capabilities": []string{"system.info"},
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
		"capabilities": []string{"task.execute"},
	}, token)
	if deniedCapability["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("ticket must not grant a capability absent from target manifest: %#v", deniedCapability)
	}
}

func TestMeshNodeRegistrationRejectsTamperedProof(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	token, deviceID := registerAccountAndDevice(t, handler, "mesh-proof@example.com")
	registration := meshRegistration(t, deviceID, "android", []map[string]string{{"id": "mesh.event.receive", "risk": "low"}})
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
	sourceNode := registerMeshNode(t, handler, token, sourceDevice, "android", []map[string]string{{"id": "mesh.event.receive", "risk": "low"}})
	targetNode := registerMeshNode(t, handler, token, targetDeviceID, "windows", []map[string]string{{"id": "mesh.event.receive", "risk": "low"}})
	ticketResponse := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/capability-tickets", map[string]any{
		"subjectNodeId": sourceNode, "targetNodeId": targetNode, "sessionId": "mesh-session-1",
		"capabilities": []string{"mesh.event.receive"},
	}, token)
	ticket, _ := ticketResponse["ticket"].(string)
	if ticketResponse["_status"] != float64(http.StatusOK) || ticket == "" {
		t.Fatalf("ticket issue failed: %#v", ticketResponse)
	}
	event := func(sequence int, eventID string, target string) map[string]any {
		payload := map[string]any{"node": "test-node"}
		return requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/events", map[string]any{
			"ticket": ticket, "eventId": eventID, "subjectNodeId": sourceNode, "targetNodeId": target,
			"sessionId": "mesh-session-1", "sequence": sequence, "type": "task.started",
			"payload":   payload,
			"signature": signedMeshEvent(t, sourceDevice, eventID, sourceNode, target, "mesh-session-1", sequence, "task.started", payload),
		}, token)
	}
	accepted := event(1, "event-1", targetNode)
	if accepted["_status"] != float64(http.StatusAccepted) {
		t.Fatalf("event should be accepted: %#v", accepted)
	}
	retry := event(1, "event-1", targetNode)
	if retry["_status"] != float64(http.StatusOK) {
		t.Fatalf("same event ID should remain an idempotent retry: %#v", retry)
	}
	tampered := requestJSON(t, handler, http.MethodPost, "/api/mesh/v1/events", map[string]any{
		"ticket": ticket, "eventId": "event-tampered", "subjectNodeId": sourceNode, "targetNodeId": targetNode,
		"sessionId": "mesh-session-1", "sequence": 2, "type": "task.progress",
		"payload": map[string]any{"node": "test-node"}, "signature": base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)),
	}, token)
	if tampered["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("unsigned or tampered event must be rejected: %#v", tampered)
	}
	claims, err := auth.ParseToken([]byte(config.JWTSecret), token)
	if err != nil {
		t.Fatal(err)
	}
	deviceToken, err := auth.IssueDeviceToken([]byte(config.JWTSecret), claims.AccountID, targetDeviceID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	missingDeviceToken := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/events?targetNodeId="+targetNode+"&after=0", nil, token)
	if missingDeviceToken["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("target node events require a device token: %#v", missingDeviceToken)
	}
	listed := requestJSON(t, handler, http.MethodGet, "/api/mesh/v1/events?targetNodeId="+targetNode+"&after=0", nil, token, map[string]string{"X-Ola-Device-Token": deviceToken})
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
	reused := event(2, "event-2", targetNode)
	if reused["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("a capability ticket nonce must be single-use: %#v", reused)
	}
	foreignTarget := event(2, "event-3", "node-not-owned")
	if foreignTarget["_status"] != float64(http.StatusForbidden) {
		t.Fatalf("ticket target substitution should be rejected: %#v", foreignTarget)
	}
}

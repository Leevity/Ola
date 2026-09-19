package httpapi

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"ola-remote-server/internal/auth"
	"ola-remote-server/internal/store"
)

const meshProtocolVersion = "v0alpha1"
const meshCapabilityTicketTTL = 5 * time.Minute

var meshCapabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31})+$`)
var meshSensitivePayloadPattern = regexp.MustCompile(`(?i)(api[_-]?key|authorization|bearer|password|passphrase|private[_-]?key|secret|token)\s*[:=]`)

// The initial secure Mesh release is status-only. Execution and file
// capabilities remain unavailable until the signed, target-confirmed task
// protocol and restricted executor are implemented.
var meshStatusCapabilities = map[string]bool{
	"mesh.event.receive": true,
	"system.info":        true,
}

type meshCapability struct {
	ID      string `json:"id"`
	Risk    string `json:"risk"`
	Version string `json:"version,omitempty"`
}

type meshNodeRecord struct {
	NodeID          string           `json:"nodeId"`
	DeviceID        string           `json:"deviceId"`
	AccountID       string           `json:"-"`
	Platform        string           `json:"platform"`
	Runtime         string           `json:"runtime"`
	RuntimeVersion  string           `json:"runtimeVersion"`
	PublicKey       string           `json:"publicKey"`
	Capabilities    []meshCapability `json:"capabilities"`
	ManifestVersion int64            `json:"manifestVersion"`
	CreatedAt       time.Time        `json:"createdAt"`
	UpdatedAt       time.Time        `json:"updatedAt"`
}

type meshEventRecord struct {
	EventID       string          `json:"eventId"`
	SubjectNodeID string          `json:"subjectNodeId"`
	TargetNodeID  string          `json:"targetNodeId"`
	SessionID     string          `json:"sessionId"`
	Sequence      int64           `json:"sequence"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	Capabilities  []string        `json:"capabilities"`
	Signature     string          `json:"signature"`
	CreatedAt     time.Time       `json:"createdAt"`
}

type meshEventDelivery struct {
	meshEventRecord
	Ticket string `json:"ticket"`
}

func (api *API) registerMeshRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mesh/v1/control-plane-key", api.meshControlPlaneKey)
	mux.HandleFunc("/api/mesh/v1/nodes/register", api.withAuth(api.meshRegisterNode))
	mux.HandleFunc("/api/mesh/v1/nodes", api.withAuth(api.meshListNodes))
	mux.HandleFunc("/api/mesh/v1/nodes/", api.withAuth(api.meshNodeAction))
	mux.HandleFunc("/api/mesh/v1/capability-tickets", api.withAuth(api.meshIssueCapabilityTicket))
	mux.HandleFunc("/api/mesh/v1/events", api.withAuth(api.meshEvents))
}

func (api *API) meshEvents(w http.ResponseWriter, r *http.Request, account store.Account) {
	switch r.Method {
	case http.MethodPost:
		api.meshPublishEvent(w, r, account)
	case http.MethodGet:
		api.meshListEvents(w, r, account)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (api *API) meshPublishEvent(w http.ResponseWriter, r *http.Request, account store.Account) {
	var req struct {
		Ticket        string          `json:"ticket"`
		EventID       string          `json:"eventId"`
		SubjectNodeID string          `json:"subjectNodeId"`
		TargetNodeID  string          `json:"targetNodeId"`
		SessionID     string          `json:"sessionId"`
		Sequence      int64           `json:"sequence"`
		Type          string          `json:"type"`
		Payload       json.RawMessage `json:"payload"`
		Signature     string          `json:"signature"`
	}
	if !readJSON(w, r, &req) || !validRemoteIdentifier(req.EventID) ||
		!validRemoteIdentifier(req.SubjectNodeID) || !validRemoteIdentifier(req.TargetNodeID) ||
		!validRemoteIdentifier(req.SessionID) || req.Sequence <= 0 || req.Sequence > 1_000_000 ||
		!validMeshEventType(req.Type) || !validMeshEventPayload(req.Payload) {
		writeError(w, http.StatusBadRequest, "invalid mesh event")
		return
	}
	key := auth.MeshControlPlanePublicKey([]byte(api.cfg.JWTSecret))
	claims, err := auth.ParseMeshCapabilityTicket(key, req.Ticket)
	if err != nil || claims.AccountID != account.ID || claims.SubjectNodeID != req.SubjectNodeID ||
		claims.TargetNodeID != req.TargetNodeID || claims.SessionID != req.SessionID {
		writeError(w, http.StatusForbidden, "invalid mesh capability ticket")
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	subject, subjectOK := api.control.MeshNodes[req.SubjectNodeID]
	target, targetOK := api.control.MeshNodes[req.TargetNodeID]
	if !subjectOK || !targetOK || subject.AccountID != account.ID || target.AccountID != account.ID {
		writeError(w, http.StatusNotFound, "mesh node not found")
		return
	}
	if !validMeshEventSignature(subject.PublicKey, req) {
		writeError(w, http.StatusForbidden, "invalid mesh event signature")
		return
	}
	queue := api.control.MeshEvents[req.TargetNodeID]
	for _, existing := range queue {
		if existing.EventID == req.EventID {
			writeJSON(w, http.StatusOK, map[string]any{"event": existing})
			return
		}
		if existing.SessionID == req.SessionID && existing.Sequence >= req.Sequence {
			writeError(w, http.StatusConflict, "mesh event sequence must advance")
			return
		}
	}
	nowUnix := time.Now().Unix()
	for nonce, expiresAt := range api.control.UsedMeshTicketNonces {
		if expiresAt <= nowUnix {
			delete(api.control.UsedMeshTicketNonces, nonce)
		}
	}
	nonceKey := claims.ID + ":" + claims.Nonce
	if _, used := api.control.UsedMeshTicketNonces[nonceKey]; used {
		writeError(w, http.StatusForbidden, "mesh capability ticket has already been used")
		return
	}
	event := meshEventRecord{EventID: req.EventID, SubjectNodeID: req.SubjectNodeID, TargetNodeID: req.TargetNodeID, SessionID: req.SessionID, Sequence: req.Sequence, Type: req.Type, Payload: append(json.RawMessage(nil), req.Payload...), Capabilities: append([]string(nil), claims.Capabilities...), Signature: req.Signature, CreatedAt: time.Now()}
	queue = append(queue, event)
	if len(queue) > 256 {
		queue = queue[len(queue)-256:]
	}
	api.control.MeshEvents[req.TargetNodeID] = queue
	api.control.UsedMeshTicketNonces[nonceKey] = claims.ExpiresAt
	api.control.persistLocked()
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
}

func validMeshEventSignature(publicKeyText string, req struct {
	Ticket        string          `json:"ticket"`
	EventID       string          `json:"eventId"`
	SubjectNodeID string          `json:"subjectNodeId"`
	TargetNodeID  string          `json:"targetNodeId"`
	SessionID     string          `json:"sessionId"`
	Sequence      int64           `json:"sequence"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	Signature     string          `json:"signature"`
}) bool {
	publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(publicKeyText))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(req.Signature))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return false
	}
	digest := sha256.Sum256(meshEventSigningBytes(req.EventID, req.SubjectNodeID, req.TargetNodeID, req.SessionID, req.Sequence, req.Type, req.Payload))
	return ed25519.Verify(ed25519.PublicKey(publicKey), digest[:], signature)
}

// meshEventSigningBytes is deliberately independent of JSON re-serialization:
// Node and Go encode some Unicode and HTML characters differently. The original
// payload bytes are bound through their hash, while the remaining validated
// fields use an unambiguous line-delimited representation.
func meshEventSigningBytes(eventID, subjectNodeID, targetNodeID, sessionID string, sequence int64, eventType string, payload json.RawMessage) []byte {
	payloadDigest := sha256.Sum256(payload)
	return []byte(strings.Join([]string{
		meshProtocolVersion,
		eventID,
		subjectNodeID,
		targetNodeID,
		sessionID,
		strconv.FormatInt(sequence, 10),
		eventType,
		hex.EncodeToString(payloadDigest[:]),
	}, "\n"))
}

func (api *API) meshListEvents(w http.ResponseWriter, r *http.Request, account store.Account) {
	targetNodeID := strings.TrimSpace(r.URL.Query().Get("targetNodeId"))
	if !validRemoteIdentifier(targetNodeID) {
		writeError(w, http.StatusBadRequest, "targetNodeId is required")
		return
	}
	after := int64(0)
	if raw := r.URL.Query().Get("after"); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &after); err != nil || after < 0 {
			writeError(w, http.StatusBadRequest, "invalid event cursor")
			return
		}
	}
	api.control.mu.RLock()
	defer api.control.mu.RUnlock()
	node, ok := api.control.MeshNodes[targetNodeID]
	if !ok || node.AccountID != account.ID {
		writeError(w, http.StatusNotFound, "mesh node not found")
		return
	}
	deviceClaims, err := auth.ParseDeviceToken([]byte(api.cfg.JWTSecret), r.Header.Get("X-Ola-Device-Token"))
	if err != nil || deviceClaims.AccountID != account.ID || deviceClaims.DeviceID != node.DeviceID {
		writeError(w, http.StatusForbidden, "target node device authentication is required")
		return
	}
	result := make([]meshEventDelivery, 0, 32)
	for _, event := range api.control.MeshEvents[targetNodeID] {
		if event.Sequence > after {
			ticket, err := auth.IssueMeshCapabilityTicket([]byte(api.cfg.JWTSecret), auth.MeshCapabilityClaims{
				AccountID: account.ID, SubjectNodeID: event.SubjectNodeID, TargetNodeID: event.TargetNodeID,
				SessionID: event.SessionID, Capabilities: event.Capabilities,
			}, time.Minute)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to issue event delivery ticket")
				return
			}
			result = append(result, meshEventDelivery{meshEventRecord: event, Ticket: ticket})
			if len(result) == 64 {
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": result})
}

func validMeshEventType(value string) bool {
	switch value {
	case "task.started", "task.progress", "task.completed", "task.failed", "task.cancelled":
		return true
	default:
		return false
	}
}

func validMeshEventPayload(payload json.RawMessage) bool {
	if len(payload) == 0 || len(payload) > 1024 {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(payload, &object) != nil || len(object) == 0 || len(object) > 8 {
		return false
	}
	for key, value := range object {
		if !regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`).MatchString(key) {
			return false
		}
		var scalar any
		if json.Unmarshal(value, &scalar) != nil {
			return false
		}
		switch item := scalar.(type) {
		case string:
			if len(item) > 256 || meshSensitivePayloadPattern.MatchString(item) {
				return false
			}
		case float64, bool, nil:
		default:
			return false
		}
	}
	return true
}

func (api *API) meshControlPlaneKey(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protocolVersion": meshProtocolVersion,
		"algorithm":       "Ed25519",
		"publicKey":       auth.MeshControlPlanePublicKey([]byte(api.cfg.JWTSecret)),
	})
}

func (api *API) meshRegisterNode(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		DeviceID       string           `json:"deviceId"`
		Platform       string           `json:"platform"`
		Runtime        string           `json:"runtime"`
		RuntimeVersion string           `json:"runtimeVersion"`
		PublicKey      string           `json:"publicKey"`
		Capabilities   []meshCapability `json:"capabilities"`
		Proof          string           `json:"proof"`
	}
	if !readJSON(w, r, &req) || !validRemoteIdentifier(req.DeviceID) ||
		!validMeshPlatform(req.Platform) || !validBoundedText(req.Runtime, 80) ||
		!validBoundedText(req.RuntimeVersion, 80) || !validMeshPublicKey(req.PublicKey) ||
		!validMeshCapabilities(req.Capabilities) || !validMeshProof(req) {
		writeError(w, http.StatusBadRequest, "invalid mesh node registration")
		return
	}
	device, ok := api.store.GetDevice(req.DeviceID)
	if !ok || device.AccountID != account.ID {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	now := time.Now()
	nodeID := "node-" + req.DeviceID
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	existing, exists := api.control.MeshNodes[nodeID]
	if exists && existing.AccountID != account.ID {
		writeError(w, http.StatusForbidden, "node does not belong to account")
		return
	}
	record := meshNodeRecord{
		NodeID: nodeID, DeviceID: req.DeviceID, AccountID: account.ID,
		Platform: strings.ToLower(req.Platform), Runtime: strings.TrimSpace(req.Runtime),
		RuntimeVersion: strings.TrimSpace(req.RuntimeVersion), PublicKey: strings.TrimSpace(req.PublicKey),
		Capabilities: normalizeCapabilities(req.Capabilities), ManifestVersion: 1, CreatedAt: now, UpdatedAt: now,
	}
	if exists {
		record.CreatedAt = existing.CreatedAt
		record.ManifestVersion = existing.ManifestVersion + 1
	}
	api.control.MeshNodes[nodeID] = record
	api.control.persistLocked()
	writeJSON(w, http.StatusOK, map[string]any{"node": record})
}

func validMeshProof(req struct {
	DeviceID       string           `json:"deviceId"`
	Platform       string           `json:"platform"`
	Runtime        string           `json:"runtime"`
	RuntimeVersion string           `json:"runtimeVersion"`
	PublicKey      string           `json:"publicKey"`
	Capabilities   []meshCapability `json:"capabilities"`
	Proof          string           `json:"proof"`
}) bool {
	publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(req.PublicKey))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return false
	}
	proof, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(req.Proof))
	if err != nil || len(proof) != ed25519.SignatureSize {
		return false
	}
	canonical, err := json.Marshal(struct {
		DeviceID       string           `json:"deviceId"`
		Platform       string           `json:"platform"`
		Runtime        string           `json:"runtime"`
		RuntimeVersion string           `json:"runtimeVersion"`
		PublicKey      string           `json:"publicKey"`
		Capabilities   []meshCapability `json:"capabilities"`
	}{req.DeviceID, req.Platform, req.Runtime, req.RuntimeVersion, req.PublicKey, req.Capabilities})
	if err != nil {
		return false
	}
	digest := sha256.Sum256(canonical)
	return ed25519.Verify(ed25519.PublicKey(publicKey), digest[:], proof)
}

func (api *API) meshListNodes(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	api.control.mu.RLock()
	defer api.control.mu.RUnlock()
	nodes := make([]meshNodeRecord, 0)
	for _, node := range api.control.MeshNodes {
		if node.AccountID == account.ID {
			nodes = append(nodes, node)
		}
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].CreatedAt.Before(nodes[j].CreatedAt) })
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (api *API) meshNodeAction(w http.ResponseWriter, r *http.Request, account store.Account) {
	path := strings.TrimPrefix(r.URL.Path, "/api/mesh/v1/nodes/")
	nodeID, action, ok := strings.Cut(path, "/")
	if !ok || !validRemoteIdentifier(nodeID) || action != "heartbeat" {
		writeError(w, http.StatusNotFound, "mesh node action not found")
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	node, exists := api.control.MeshNodes[nodeID]
	if !exists || node.AccountID != account.ID {
		writeError(w, http.StatusNotFound, "mesh node not found")
		return
	}
	if _, err := api.store.HeartbeatDevice(account.ID, node.DeviceID); err != nil {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	node.UpdatedAt = time.Now()
	api.control.MeshNodes[nodeID] = node
	api.control.persistLocked()
	writeJSON(w, http.StatusOK, map[string]any{"node": node})
}

func (api *API) meshIssueCapabilityTicket(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		SubjectNodeID string   `json:"subjectNodeId"`
		TargetNodeID  string   `json:"targetNodeId"`
		SessionID     string   `json:"sessionId"`
		Capabilities  []string `json:"capabilities"`
	}
	if !readJSON(w, r, &req) || !validRemoteIdentifier(req.SubjectNodeID) ||
		!validRemoteIdentifier(req.TargetNodeID) || !validRemoteIdentifier(req.SessionID) ||
		len(req.Capabilities) == 0 || len(req.Capabilities) > 16 || !validMeshCapabilityIDs(req.Capabilities) {
		writeError(w, http.StatusBadRequest, "invalid capability ticket request")
		return
	}
	for _, capability := range req.Capabilities {
		if !meshStatusCapabilities[capability] {
			writeError(w, http.StatusForbidden, "remote execution capabilities are disabled pending the signed task protocol")
			return
		}
	}
	api.control.mu.RLock()
	subject, subjectExists := api.control.MeshNodes[req.SubjectNodeID]
	target, targetExists := api.control.MeshNodes[req.TargetNodeID]
	api.control.mu.RUnlock()
	if !subjectExists || !targetExists || subject.AccountID != account.ID || target.AccountID != account.ID {
		writeError(w, http.StatusNotFound, "mesh node not found")
		return
	}
	if !targetSupportsCapabilities(target, req.Capabilities) {
		writeError(w, http.StatusForbidden, "target node does not provide requested capability")
		return
	}
	ticket, err := auth.IssueMeshCapabilityTicket([]byte(api.cfg.JWTSecret), auth.MeshCapabilityClaims{
		AccountID: account.ID, SubjectNodeID: subject.NodeID, TargetNodeID: target.NodeID,
		SessionID: req.SessionID, Capabilities: req.Capabilities,
	}, meshCapabilityTicketTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue capability ticket")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ticket": ticket, "expiresIn": int(meshCapabilityTicketTTL.Seconds()),
		"ticketFingerprint": auth.TicketFingerprint(ticket),
	})
}

func validMeshPlatform(platform string) bool {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "android", "ios", "linux", "macos", "windows":
		return true
	default:
		return false
	}
}

func validMeshPublicKey(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	return err == nil && len(decoded) == 32
}

func validMeshCapabilities(capabilities []meshCapability) bool {
	if len(capabilities) > 64 {
		return false
	}
	seen := map[string]bool{}
	for _, capability := range capabilities {
		if !meshCapabilityPattern.MatchString(capability.ID) || seen[capability.ID] ||
			!meshStatusCapabilities[capability.ID] || capability.Risk != "low" ||
			len(capability.Version) > 32 {
			return false
		}
		seen[capability.ID] = true
	}
	return true
}

func validMeshCapabilityIDs(capabilities []string) bool {
	seen := map[string]bool{}
	for _, capability := range capabilities {
		if !meshCapabilityPattern.MatchString(capability) || seen[capability] {
			return false
		}
		seen[capability] = true
	}
	return true
}

func normalizeCapabilities(capabilities []meshCapability) []meshCapability {
	result := append([]meshCapability(nil), capabilities...)
	for index := range result {
		result[index].ID = strings.TrimSpace(result[index].ID)
		result[index].Version = strings.TrimSpace(result[index].Version)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func targetSupportsCapabilities(target meshNodeRecord, requested []string) bool {
	provided := map[string]bool{}
	for _, capability := range target.Capabilities {
		provided[capability.ID] = true
	}
	for _, capability := range requested {
		if !provided[capability] {
			return false
		}
	}
	return true
}

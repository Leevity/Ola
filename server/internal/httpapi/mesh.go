package httpapi

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"ola-remote-server/internal/auth"
	"ola-remote-server/internal/store"
)

const meshProtocolVersion = "v0alpha1"
const meshCapabilityTicketTTL = 5 * time.Minute

var meshCapabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31})+$`)

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
	event := meshEventRecord{EventID: req.EventID, SubjectNodeID: req.SubjectNodeID, TargetNodeID: req.TargetNodeID, SessionID: req.SessionID, Sequence: req.Sequence, Type: req.Type, Payload: append(json.RawMessage(nil), req.Payload...), Capabilities: append([]string(nil), claims.Capabilities...), CreatedAt: time.Now()}
	queue = append(queue, event)
	if len(queue) > 256 {
		queue = queue[len(queue)-256:]
	}
	api.control.MeshEvents[req.TargetNodeID] = queue
	api.control.persistLocked()
	writeJSON(w, http.StatusAccepted, map[string]any{"event": event})
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
	case "task.command", "task.started", "task.stdout", "task.stderr", "task.progress", "task.approval_required", "task.completed", "task.failed", "task.cancelled":
		return true
	default:
		return false
	}
}

func validMeshEventPayload(payload json.RawMessage) bool {
	if len(payload) == 0 || len(payload) > 32<<10 {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(payload, &object) == nil && object != nil
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
			(capability.Risk != "low" && capability.Risk != "medium" && capability.Risk != "high") ||
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

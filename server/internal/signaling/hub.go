package signaling

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"time"

	"ola-remote-server/internal/auth"
)

type SignalMessage struct {
	Type          string          `json:"type"`
	From          string          `json:"from,omitempty"`
	To            string          `json:"to,omitempty"`
	SessionID     string          `json:"sessionId,omitempty"`
	Payload       json.RawMessage `json:"payload,omitempty"`
	Authorization string          `json:"authorization,omitempty"`
	PeerName      string          `json:"peerName,omitempty"`
	SentAt        time.Time       `json:"sentAt"`
}

type Client struct {
	deviceID string
	hub      *Hub
	conn     *WebSocketConn
	send     chan []byte
}

type Hub struct {
	mu               sync.RWMutex
	clients          map[string]*Client
	secret           []byte
	consumedTickets  map[string]time.Time
	sessions         map[string]authorizedSession
	revokedDevices   map[string]time.Time
	allowedDevices   map[string]bool
	revocationLookup RevocationLookup
	sharedSessions   SharedSessionState
	signalPublisher  SignalPublisher
	activeSessionTTL time.Duration
	sessionAuditor   SessionAuditor
	auditEvents      chan sessionAuditEvent
}

type RevocationLookup interface {
	RevokedAt(deviceID string) (time.Time, bool)
}

type RemotePermissionLookup interface {
	IsDeviceRemoteAllowed(deviceID string) bool
}

type SharedAuthorizedSession struct {
	ID, AccountID, Controller, Controlled string
	StartedAt, ExpiresAt                  time.Time
}

var ErrRemoteDeviceBusy = errors.New("remote device already has an active session")

type SharedSessionState interface {
	ConsumeRemoteTicket(id string, expiresAt time.Time) bool
	SaveRemoteSession(session SharedAuthorizedSession) error
	GetRemoteSession(sessionID string) (SharedAuthorizedSession, bool)
	DeleteRemoteSession(sessionID string)
}

type SignalPublisher interface {
	PublishSignal(payload []byte) error
}

type authorizedSession struct {
	id         string
	accountID  string
	controller string
	controlled string
	startedAt  time.Time
	expiresAt  time.Time
}

type SessionAuditor interface {
	RemoteSessionStarted(sessionID, controllerAccountID, controllerDeviceID, controlledDeviceID string, startedAt time.Time) error
	RemoteSessionUpdated(sessionID, transport string, bytesTransferred int64, updatedAt time.Time) error
	RemoteSessionEnded(sessionID, reason string, endedAt time.Time) error
}

type sessionStats struct {
	Transport        string `json:"transport"`
	BytesTransferred int64  `json:"bytesTransferred"`
}

type sessionAuditEvent struct {
	started   *authorizedSession
	stats     *sessionStats
	endedID   string
	sessionID string
	reason    string
	at        time.Time
}

func (h *Hub) SetRevocationLookup(lookup RevocationLookup) {
	h.mu.Lock()
	h.revocationLookup = lookup
	h.mu.Unlock()
}

func (h *Hub) SetSharedSessionState(state SharedSessionState) {
	h.mu.Lock()
	h.sharedSessions = state
	h.mu.Unlock()
}

func (h *Hub) SetSignalPublisher(publisher SignalPublisher) {
	h.mu.Lock()
	h.signalPublisher = publisher
	h.mu.Unlock()
}

func (h *Hub) DeliverSharedSignal(payload []byte) {
	var message SignalMessage
	if err := json.Unmarshal(payload, &message); err != nil || message.To == "" {
		return
	}
	h.mu.Lock()
	if message.Type == "offer" && message.SessionID != "" && h.sharedSessions != nil {
		if shared, ok := h.sharedSessions.GetRemoteSession(message.SessionID); ok &&
			shared.Controller == message.From && shared.Controlled == message.To {
			h.sessions[message.SessionID] = authorizedSession{
				id: shared.ID, accountID: shared.AccountID, controller: shared.Controller,
				controlled: shared.Controlled, startedAt: shared.StartedAt, expiresAt: shared.ExpiresAt,
			}
		}
	} else if message.Type == "close" && message.SessionID != "" {
		delete(h.sessions, message.SessionID)
	}
	target := h.clients[message.To]
	h.mu.Unlock()
	if target == nil {
		return
	}
	select {
	case target.send <- append([]byte(nil), payload...):
	default:
		log.Printf("shared signal target queue is full: %s", message.To)
	}
}

func (h *Hub) SetSessionAuditor(auditor SessionAuditor) {
	h.mu.Lock()
	h.sessionAuditor = auditor
	h.mu.Unlock()
}

func NewHub(secret []byte) *Hub {
	hub := &Hub{
		clients: make(map[string]*Client), secret: append([]byte(nil), secret...),
		consumedTickets: make(map[string]time.Time), sessions: make(map[string]authorizedSession),
		revokedDevices:   make(map[string]time.Time),
		allowedDevices:   make(map[string]bool),
		activeSessionTTL: 12 * time.Hour,
		auditEvents:      make(chan sessionAuditEvent, 128),
	}
	go hub.auditLoop()
	return hub
}

func (h *Hub) SetDeviceRemoteAllowed(deviceID string, allowed bool) {
	if deviceID == "" {
		return
	}
	h.mu.Lock()
	h.allowedDevices[deviceID] = allowed
	h.mu.Unlock()
}

func (h *Hub) IsDeviceRemoteAllowed(deviceID string) bool {
	h.mu.RLock()
	allowed := h.allowedDevices[deviceID]
	lookup := h.revocationLookup
	h.mu.RUnlock()
	if permissionLookup, ok := lookup.(RemotePermissionLookup); ok {
		return permissionLookup.IsDeviceRemoteAllowed(deviceID)
	}
	return allowed
}

func (h *Hub) SetActiveSessionTTL(ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	h.mu.Lock()
	h.activeSessionTTL = ttl
	h.mu.Unlock()
}

func (h *Hub) RevokeDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	h.mu.Lock()
	h.revokedDevices[deviceID] = time.Now()
	h.allowedDevices[deviceID] = false
	clientsToClose := make(map[*Client]struct{})
	for sessionID, session := range h.sessions {
		if session.controller != deviceID && session.controlled != deviceID {
			continue
		}
		if client := h.clients[session.controller]; client != nil {
			clientsToClose[client] = struct{}{}
		}
		if client := h.clients[session.controlled]; client != nil {
			clientsToClose[client] = struct{}{}
		}
		delete(h.sessions, sessionID)
		h.queueAudit(sessionAuditEvent{endedID: sessionID, reason: "device_revoked", at: time.Now()})
	}
	h.mu.Unlock()
	for client := range clientsToClose {
		client.close()
	}
}

func (h *Hub) Register(deviceID string, conn *WebSocketConn) *Client {
	client := &Client{deviceID: deviceID, hub: h, conn: conn, send: make(chan []byte, 32)}
	h.mu.Lock()
	if existing := h.clients[deviceID]; existing != nil {
		existing.close()
	}
	h.clients[deviceID] = client
	h.mu.Unlock()
	return client
}

func (h *Hub) unregister(client *Client) {
	type pendingClose struct {
		target    *Client
		publisher SignalPublisher
		payload   []byte
		deviceID  string
	}
	var pending []pendingClose
	h.mu.Lock()
	if h.clients[client.deviceID] == client {
		delete(h.clients, client.deviceID)
	}
	for sessionID, session := range h.sessions {
		if session.controller == client.deviceID || session.controlled == client.deviceID {
			delete(h.sessions, sessionID)
			if h.sharedSessions != nil {
				h.sharedSessions.DeleteRemoteSession(sessionID)
			}
			peerDeviceID := session.controller
			if peerDeviceID == client.deviceID {
				peerDeviceID = session.controlled
			}
			closePayload, _ := json.Marshal(map[string]string{"label": "device_disconnected"})
			payload, _ := json.Marshal(SignalMessage{
				Type: "close", From: client.deviceID, To: peerDeviceID, SessionID: sessionID,
				Payload: closePayload, SentAt: time.Now(),
			})
			pending = append(pending, pendingClose{
				target: h.clients[peerDeviceID], publisher: h.signalPublisher,
				payload: payload, deviceID: peerDeviceID,
			})
			h.queueAudit(sessionAuditEvent{endedID: sessionID, reason: "device_disconnected", at: time.Now()})
		}
	}
	h.mu.Unlock()
	for _, closeMessage := range pending {
		if closeMessage.target != nil {
			select {
			case closeMessage.target.send <- closeMessage.payload:
			default:
				log.Printf("session close target queue is full: %s", closeMessage.deviceID)
			}
		} else if closeMessage.publisher != nil {
			if err := closeMessage.publisher.PublishSignal(closeMessage.payload); err != nil {
				log.Printf("publish session close after disconnect: %v", err)
			}
		}
	}
	client.close()
}

func (h *Hub) forward(message SignalMessage) error {
	switch message.Type {
	case "offer", "answer", "candidate", "close", "stats", "ping":
	default:
		return errors.New("unsupported signal message type")
	}
	if len(message.To) > 128 || len(message.SessionID) > 128 ||
		len(message.Authorization) > 8192 || len(message.Payload) > 512<<10 {
		return errors.New("signal message exceeds size limits")
	}
	if message.To == "" {
		return errors.New("target device is required")
	}
	if message.Type != "ping" || message.To != message.From {
		if err := h.authorize(&message); err != nil {
			return err
		}
	}
	if message.Type == "stats" {
		return nil
	}
	message.SentAt = time.Now()
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	h.mu.RLock()
	target := h.clients[message.To]
	publisher := h.signalPublisher
	h.mu.RUnlock()
	if target == nil {
		if publisher == nil {
			return errors.New("target device is not connected")
		}
		return publisher.PublishSignal(payload)
	}
	select {
	case target.send <- payload:
		return nil
	default:
		return errors.New("target send queue is full")
	}
}

func (h *Hub) authorize(message *SignalMessage) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	message.PeerName = ""
	now := time.Now()
	for id, expiresAt := range h.consumedTickets {
		if expiresAt.Before(now) {
			delete(h.consumedTickets, id)
		}
	}
	for id, session := range h.sessions {
		if session.expiresAt.Before(now) {
			delete(h.sessions, id)
			if h.sharedSessions != nil {
				h.sharedSessions.DeleteRemoteSession(id)
			}
			h.queueAudit(sessionAuditEvent{endedID: id, reason: "session_expired", at: now})
		}
	}

	if message.Type == "offer" {
		claims, err := auth.ParseRemoteSessionTicket(h.secret, message.Authorization)
		if err != nil {
			return errors.New("invalid remote session authorization")
		}
		if claims.ControllerDevice != message.From || claims.ControlledDevice != message.To ||
			claims.SessionID != message.SessionID {
			return errors.New("remote session authorization does not match message")
		}
		allowed := h.allowedDevices[claims.ControlledDevice]
		if permissionLookup, ok := h.revocationLookup.(RemotePermissionLookup); ok {
			allowed = permissionLookup.IsDeviceRemoteAllowed(claims.ControlledDevice)
		}
		if !allowed {
			return errors.New("controlled device is not allowing remote control")
		}
		revokedAt, revoked := h.revokedDevices[claims.ControlledDevice]
		if !revoked && h.revocationLookup != nil {
			revokedAt, revoked = h.revocationLookup.RevokedAt(claims.ControlledDevice)
		}
		if revoked && claims.IssuedAt <= revokedAt.UnixMilli() {
			return errors.New("controlled device authorization was revoked")
		}
		if h.sharedSessions == nil {
			for _, session := range h.sessions {
				if session.controller == claims.ControllerDevice || session.controlled == claims.ControllerDevice ||
					session.controller == claims.ControlledDevice || session.controlled == claims.ControlledDevice {
					return ErrRemoteDeviceBusy
				}
			}
		}
		ticketExpiresAt := time.Unix(claims.ExpiresAt, 0)
		if h.sharedSessions != nil {
			if !h.sharedSessions.ConsumeRemoteTicket(claims.ID, ticketExpiresAt) {
				return errors.New("remote session authorization was already used")
			}
		} else {
			if _, used := h.consumedTickets[claims.ID]; used {
				return errors.New("remote session authorization was already used")
			}
			h.consumedTickets[claims.ID] = ticketExpiresAt
		}
		h.sessions[claims.SessionID] = authorizedSession{
			id: claims.SessionID, accountID: claims.ControllerAccount,
			controller: claims.ControllerDevice, controlled: claims.ControlledDevice, startedAt: now,
			expiresAt: now.Add(h.activeSessionTTL),
		}
		session := h.sessions[claims.SessionID]
		if h.sharedSessions != nil {
			if err := h.sharedSessions.SaveRemoteSession(SharedAuthorizedSession{
				ID: session.id, AccountID: session.accountID, Controller: session.controller,
				Controlled: session.controlled, StartedAt: session.startedAt, ExpiresAt: session.expiresAt,
			}); err != nil {
				delete(h.sessions, claims.SessionID)
				if errors.Is(err, ErrRemoteDeviceBusy) {
					return ErrRemoteDeviceBusy
				}
				return errors.New("persist remote session authorization")
			}
		}
		h.queueAudit(sessionAuditEvent{started: &session, at: now})
		message.Authorization = ""
		message.PeerName = claims.ControllerName
		return nil
	}

	var session authorizedSession
	var ok bool
	if h.sharedSessions != nil {
		if shared, found := h.sharedSessions.GetRemoteSession(message.SessionID); found {
			session = authorizedSession{id: shared.ID, accountID: shared.AccountID,
				controller: shared.Controller, controlled: shared.Controlled,
				startedAt: shared.StartedAt, expiresAt: shared.ExpiresAt}
			h.sessions[message.SessionID] = session
			ok = true
		} else {
			delete(h.sessions, message.SessionID)
		}
	} else {
		session, ok = h.sessions[message.SessionID]
	}
	if !ok {
		return errors.New("remote session is not authorized")
	}
	forward := message.From == session.controller && message.To == session.controlled
	reverse := message.From == session.controlled && message.To == session.controller
	if !forward && !reverse {
		return errors.New("signal sender or target is not part of the session")
	}
	allowed := h.allowedDevices[session.controlled]
	if permissionLookup, lookupOK := h.revocationLookup.(RemotePermissionLookup); lookupOK {
		allowed = permissionLookup.IsDeviceRemoteAllowed(session.controlled)
	}
	if !allowed {
		delete(h.sessions, message.SessionID)
		if h.sharedSessions != nil {
			h.sharedSessions.DeleteRemoteSession(message.SessionID)
		}
		h.queueAudit(sessionAuditEvent{endedID: message.SessionID, reason: "permission_revoked", at: now})
		return errors.New("controlled device is not allowing remote control")
	}
	if message.Type == "stats" {
		if !forward {
			return errors.New("only the controller may report session stats")
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(message.Payload, &fields); err != nil || len(fields) != 2 ||
			fields["transport"] == nil || fields["bytesTransferred"] == nil {
			return errors.New("invalid session stats")
		}
		var stats sessionStats
		if err := json.Unmarshal(message.Payload, &stats); err != nil ||
			(stats.Transport != "p2p" && stats.Transport != "turn") ||
			stats.BytesTransferred < 0 || stats.BytesTransferred > 1<<60 {
			return errors.New("invalid session stats")
		}
		h.queueAudit(sessionAuditEvent{sessionID: message.SessionID, stats: &stats, at: now})
	}
	if message.Type == "close" {
		delete(h.sessions, message.SessionID)
		if h.sharedSessions != nil {
			h.sharedSessions.DeleteRemoteSession(message.SessionID)
		}
		h.queueAudit(sessionAuditEvent{endedID: message.SessionID, reason: "peer_closed", at: now})
	}
	message.Authorization = ""
	return nil
}

func (h *Hub) queueAudit(event sessionAuditEvent) {
	select {
	case h.auditEvents <- event:
	default:
		log.Printf("remote session audit queue is full")
	}
}

func (h *Hub) auditLoop() {
	for event := range h.auditEvents {
		h.mu.RLock()
		auditor := h.sessionAuditor
		h.mu.RUnlock()
		if auditor == nil {
			continue
		}
		var err error
		if event.started != nil {
			session := event.started
			err = auditor.RemoteSessionStarted(session.id, session.accountID, session.controller,
				session.controlled, session.startedAt)
		} else if event.stats != nil {
			err = auditor.RemoteSessionUpdated(event.sessionID, event.stats.Transport,
				event.stats.BytesTransferred, event.at)
		} else {
			err = auditor.RemoteSessionEnded(event.endedID, event.reason, event.at)
		}
		if err != nil {
			log.Printf("record remote session audit: %v", err)
		}
	}
}

func (c *Client) Run() {
	done := make(chan struct{})
	go c.writeLoop(done)
	c.readLoop()
	close(done)
	c.hub.unregister(c)
}

func (c *Client) readLoop() {
	for {
		payload, err := c.conn.ReadText()
		if err != nil {
			return
		}
		var message SignalMessage
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&message); err != nil {
			_ = c.conn.WriteText([]byte(`{"type":"error","payload":{"message":"invalid json"}}`))
			continue
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			_ = c.conn.WriteText([]byte(`{"type":"error","payload":{"message":"invalid json"}}`))
			continue
		}
		message.From = c.deviceID
		if err := c.hub.forward(message); err != nil {
			log.Printf("signaling forward failed: %v", err)
			errorPayload, _ := json.Marshal(map[string]string{"message": err.Error()})
			response, _ := json.Marshal(SignalMessage{Type: "error", From: "server", To: c.deviceID,
				SentAt: time.Now(), Payload: errorPayload})
			_ = c.conn.WriteText(response)
		}
	}
}

func (c *Client) writeLoop(done <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case payload := <-c.send:
			if err := c.conn.WriteText(payload); err != nil {
				return
			}
		case <-done:
			return
		case <-ticker.C:
			if err := c.conn.WritePing(); err != nil {
				c.close()
				return
			}
		}
	}
}

func (c *Client) close() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

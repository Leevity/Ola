package signaling

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ola-remote-server/internal/auth"
)

type auditRecorder struct {
	mu      sync.Mutex
	started []string
	ended   map[string]string
	stats   map[string]sessionStats
}

type sharedSessionRecorder struct {
	mu       sync.Mutex
	tickets  map[string]bool
	sessions map[string]SharedAuthorizedSession
}

func newSharedSessionRecorder() *sharedSessionRecorder {
	return &sharedSessionRecorder{
		tickets: make(map[string]bool), sessions: make(map[string]SharedAuthorizedSession),
	}
}

func (s *sharedSessionRecorder) ConsumeRemoteTicket(id string, _ time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tickets[id] {
		return false
	}
	s.tickets[id] = true
	return true
}

func (s *sharedSessionRecorder) SaveRemoteSession(session SharedAuthorizedSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, active := range s.sessions {
		if active.Controller == session.Controller || active.Controlled == session.Controller ||
			active.Controller == session.Controlled || active.Controlled == session.Controlled {
			return ErrRemoteDeviceBusy
		}
	}
	s.sessions[session.ID] = session
	return nil
}

func (s *sharedSessionRecorder) GetRemoteSession(id string) (SharedAuthorizedSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	return session, ok
}

func (s *sharedSessionRecorder) DeleteRemoteSession(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

type bridgePublisher struct{ deliver func([]byte) }

func (p bridgePublisher) PublishSignal(payload []byte) error {
	p.deliver(payload)
	return nil
}

func (r *auditRecorder) RemoteSessionUpdated(sessionID, transport string, bytesTransferred int64, _ time.Time) error {
	r.mu.Lock()
	if r.stats == nil {
		r.stats = make(map[string]sessionStats)
	}
	r.stats[sessionID] = sessionStats{Transport: transport, BytesTransferred: bytesTransferred}
	r.mu.Unlock()
	return nil
}

func (r *auditRecorder) RemoteSessionStarted(sessionID, _, _, _ string, _ time.Time) error {
	r.mu.Lock()
	r.started = append(r.started, sessionID)
	r.mu.Unlock()
	return nil
}

func (r *auditRecorder) RemoteSessionEnded(sessionID, reason string, _ time.Time) error {
	r.mu.Lock()
	if r.ended == nil {
		r.ended = make(map[string]string)
	}
	r.ended[sessionID] = reason
	r.mu.Unlock()
	return nil
}

func waitForAudit(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for session audit")
		}
		time.Sleep(time.Millisecond)
	}
}

func issueTicket(t *testing.T, secret []byte) string {
	t.Helper()
	ticket, err := auth.IssueRemoteSessionTicket(secret, auth.RemoteSessionClaims{
		ControllerAccount: "account-a",
		ControllerDevice:  "controller-a",
		ControlledDevice:  "controlled-b",
		SessionID:         "session-1",
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}

func issueTicketFor(t *testing.T, secret []byte, controller, controlled, sessionID string) string {
	t.Helper()
	ticket, err := auth.IssueRemoteSessionTicket(secret, auth.RemoteSessionClaims{
		ControllerAccount: "account-a", ControllerDevice: controller,
		ControlledDevice: controlled, SessionID: sessionID,
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}

func newAllowedTestHub(secret []byte) *Hub {
	hub := NewHub(secret)
	hub.SetDeviceRemoteAllowed("controlled-b", true)
	return hub
}

func TestOfferConsumesTicketAndAuthorizesOnlyParticipants(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	ticket := issueTicket(t, secret)
	offer := SignalMessage{
		Type: "offer", From: "controller-a", To: "controlled-b", SessionID: "session-1",
		Authorization: ticket,
	}
	if err := hub.authorize(&offer); err != nil {
		t.Fatal(err)
	}
	if offer.Authorization != "" {
		t.Fatal("authorization must be stripped before forwarding")
	}
	if err := hub.authorize(&SignalMessage{
		Type: "answer", From: "controlled-b", To: "controller-a", SessionID: "session-1",
	}); err != nil {
		t.Fatalf("expected the controlled device answer to be authorized: %v", err)
	}
	if err := hub.authorize(&SignalMessage{
		Type: "candidate", From: "attacker", To: "controlled-b", SessionID: "session-1",
	}); err == nil {
		t.Fatal("expected a non-participant to be rejected")
	}
	if err := hub.authorize(&SignalMessage{
		Type: "offer", From: "controller-a", To: "controlled-b", SessionID: "session-1",
		Authorization: ticket,
	}); err == nil {
		t.Fatal("expected replayed ticket to be rejected")
	}
}

func TestOfferRejectsTicketBoundToDifferentMessage(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	ticket := issueTicket(t, secret)
	for _, message := range []SignalMessage{
		{Type: "offer", From: "attacker", To: "controlled-b", SessionID: "session-1", Authorization: ticket},
		{Type: "offer", From: "controller-a", To: "other-device", SessionID: "session-1", Authorization: ticket},
		{Type: "offer", From: "controller-a", To: "controlled-b", SessionID: "other-session", Authorization: ticket},
	} {
		if err := hub.authorize(&message); err == nil {
			t.Fatalf("expected mismatched message to be rejected: %#v", message)
		}
	}
}

func TestActiveSessionOutlivesHandshakeTicket(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	hub.SetActiveSessionTTL(time.Minute)
	ticket, err := auth.IssueRemoteSessionTicket(secret, auth.RemoteSessionClaims{
		ControllerAccount: "account-a", ControllerDevice: "controller-a",
		ControlledDevice: "controlled-b", SessionID: "session-short-ticket",
	}, 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	offer := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-short-ticket", Authorization: ticket}
	if err := hub.authorize(&offer); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if err := hub.authorize(&SignalMessage{Type: "candidate", From: "controlled-b",
		To: "controller-a", SessionID: "session-short-ticket"}); err != nil {
		t.Fatalf("active session should outlive its one-time handshake ticket: %v", err)
	}
}

func TestRevokeDeviceRejectsPreviouslyIssuedTicket(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	ticket := issueTicket(t, secret)
	hub.RevokeDevice("controlled-b")
	message := SignalMessage{
		Type: "offer", From: "controller-a", To: "controlled-b", SessionID: "session-1",
		Authorization: ticket,
	}
	if err := hub.authorize(&message); err == nil {
		t.Fatal("expected a ticket issued before device revocation to be rejected")
	}
}

func TestSessionAuditRecordsStartAndRevoke(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	recorder := &auditRecorder{}
	hub.SetSessionAuditor(recorder)
	offer := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Authorization: issueTicket(t, secret)}
	if err := hub.authorize(&offer); err != nil {
		t.Fatal(err)
	}
	hub.RevokeDevice("controlled-b")
	waitForAudit(t, func() bool {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		return len(recorder.started) == 1 && recorder.ended["session-1"] == "device_revoked"
	})
}

func TestCloseSignalEndsAuthorizedSessionAndAudits(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	recorder := &auditRecorder{}
	hub.SetSessionAuditor(recorder)
	offer := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Authorization: issueTicket(t, secret)}
	if err := hub.authorize(&offer); err != nil {
		t.Fatal(err)
	}
	closeMessage := SignalMessage{Type: "close", From: "controller-a", To: "controlled-b", SessionID: "session-1"}
	if err := hub.authorize(&closeMessage); err != nil {
		t.Fatal(err)
	}
	if err := hub.authorize(&SignalMessage{Type: "candidate", From: "controlled-b",
		To: "controller-a", SessionID: "session-1"}); err == nil {
		t.Fatal("closed session must reject further signaling")
	}
	waitForAudit(t, func() bool {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		return recorder.ended["session-1"] == "peer_closed"
	})
}

func TestControllerSessionStatsAreValidatedAndAudited(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	recorder := &auditRecorder{}
	hub.SetSessionAuditor(recorder)
	offer := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Authorization: issueTicket(t, secret)}
	if err := hub.authorize(&offer); err != nil {
		t.Fatal(err)
	}
	stats := SignalMessage{Type: "stats", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Payload: []byte(`{"transport":"turn","bytesTransferred":4096}`)}
	if err := hub.authorize(&stats); err != nil {
		t.Fatal(err)
	}
	waitForAudit(t, func() bool {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		value, ok := recorder.stats["session-1"]
		return ok && value.Transport == "turn" && value.BytesTransferred == 4096
	})

	for _, invalid := range []SignalMessage{
		{Type: "stats", From: "controlled-b", To: "controller-a", SessionID: "session-1", Payload: stats.Payload},
		{Type: "stats", From: "controller-a", To: "controlled-b", SessionID: "session-1", Payload: []byte(`{"transport":"invalid","bytesTransferred":1}`)},
		{Type: "stats", From: "controller-a", To: "controlled-b", SessionID: "session-1", Payload: []byte(`{"transport":"p2p","bytesTransferred":-1}`)},
		{Type: "stats", From: "controller-a", To: "controlled-b", SessionID: "session-1", Payload: []byte(`{"transport":"p2p","bytesTransferred":1,"extra":true}`)},
	} {
		if err := hub.authorize(&invalid); err == nil {
			t.Fatalf("expected invalid stats to be rejected: %#v", invalid)
		}
	}
}

func TestOfferRequiresControlledDevicePermission(t *testing.T) {
	secret := []byte("test-secret")
	hub := NewHub(secret)
	offer := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Authorization: issueTicket(t, secret)}
	if err := hub.authorize(&offer); err == nil {
		t.Fatal("offer must be rejected until the controlled device enables remote control")
	}
}

func TestOfferRejectsConcurrentSessionForSameDevice(t *testing.T) {
	secret := []byte("test-secret")
	hub := newAllowedTestHub(secret)
	first := SignalMessage{Type: "offer", From: "controller-a", To: "controlled-b",
		SessionID: "session-1", Authorization: issueTicketFor(t, secret, "controller-a", "controlled-b", "session-1")}
	if err := hub.authorize(&first); err != nil {
		t.Fatal(err)
	}
	second := SignalMessage{Type: "offer", From: "controller-c", To: "controlled-b",
		SessionID: "session-2", Authorization: issueTicketFor(t, secret, "controller-c", "controlled-b", "session-2")}
	if err := hub.authorize(&second); !errors.Is(err, ErrRemoteDeviceBusy) {
		t.Fatalf("second controller must be rejected while device is busy, got %v", err)
	}
}

func TestSignalMessagesRejectUnknownTypeAndOversizedFields(t *testing.T) {
	hub := NewHub([]byte("test-secret"))
	if err := hub.forward(SignalMessage{Type: "execute", From: "controller", To: "controlled"}); err == nil || err.Error() != "unsupported signal message type" {
		t.Fatalf("expected unknown signal type rejection, got %v", err)
	}
	if err := hub.forward(SignalMessage{Type: "ping", From: "controller", To: strings.Repeat("x", 129)}); err == nil || err.Error() != "signal message exceeds size limits" {
		t.Fatalf("expected signal size rejection, got %v", err)
	}
}

func TestSharedStateBridgesAuthorizedSessionAcrossHubs(t *testing.T) {
	secret := []byte("test-secret")
	shared := newSharedSessionRecorder()
	hubA := NewHub(secret)
	hubB := NewHub(secret)
	for _, hub := range []*Hub{hubA, hubB} {
		hub.SetDeviceRemoteAllowed("controlled-b", true)
		hub.SetSharedSessionState(shared)
	}
	hubA.SetSignalPublisher(bridgePublisher{deliver: hubB.DeliverSharedSignal})
	hubB.SetSignalPublisher(bridgePublisher{deliver: hubA.DeliverSharedSignal})
	controller := &Client{deviceID: "controller-a", hub: hubA, send: make(chan []byte, 2)}
	controlled := &Client{deviceID: "controlled-b", hub: hubB, send: make(chan []byte, 2)}
	hubA.clients[controller.deviceID] = controller
	hubB.clients[controlled.deviceID] = controlled

	offer := SignalMessage{Type: "offer", From: controller.deviceID, To: controlled.deviceID,
		SessionID: "session-1", Authorization: issueTicket(t, secret)}
	if err := hubA.forward(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-controlled.send:
	case <-time.After(time.Second):
		t.Fatal("offer was not bridged to the controlled device on hub B")
	}

	answer := SignalMessage{Type: "answer", From: controlled.deviceID, To: controller.deviceID,
		SessionID: "session-1"}
	if err := hubB.forward(answer); err != nil {
		t.Fatalf("hub B did not load shared session authorization: %v", err)
	}
	select {
	case <-controller.send:
	case <-time.After(time.Second):
		t.Fatal("answer was not bridged back to the controller on hub A")
	}

	if err := hubB.forward(offer); err == nil || err.Error() != "remote session authorization was already used" {
		t.Fatalf("cross-hub ticket replay must be rejected, got %v", err)
	}
	if err := hubB.forward(SignalMessage{Type: "close", From: controlled.deviceID,
		To: controller.deviceID, SessionID: "session-1"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := shared.GetRemoteSession("session-1"); ok {
		t.Fatal("close must delete the shared session")
	}
	if err := hubA.forward(SignalMessage{Type: "candidate", From: controller.deviceID,
		To: controlled.deviceID, SessionID: "session-1"}); err == nil {
		t.Fatal("a hub-local cache must not authorize a session deleted from shared state")
	}
}

func TestDisconnectDeletesSharedSessionAndClosesRemotePeer(t *testing.T) {
	secret := []byte("test-secret")
	shared := newSharedSessionRecorder()
	hubA := NewHub(secret)
	hubB := NewHub(secret)
	for _, hub := range []*Hub{hubA, hubB} {
		hub.SetDeviceRemoteAllowed("controlled-b", true)
		hub.SetSharedSessionState(shared)
	}
	hubA.SetSignalPublisher(bridgePublisher{deliver: hubB.DeliverSharedSignal})
	hubB.SetSignalPublisher(bridgePublisher{deliver: hubA.DeliverSharedSignal})
	controller := &Client{deviceID: "controller-a", hub: hubA, send: make(chan []byte, 2)}
	controlled := &Client{deviceID: "controlled-b", hub: hubB, send: make(chan []byte, 2)}
	hubA.clients[controller.deviceID] = controller
	hubB.clients[controlled.deviceID] = controlled

	offer := SignalMessage{Type: "offer", From: controller.deviceID, To: controlled.deviceID,
		SessionID: "session-disconnect", Authorization: issueTicketFor(t, secret,
			controller.deviceID, controlled.deviceID, "session-disconnect")}
	if err := hubA.forward(offer); err != nil {
		t.Fatal(err)
	}
	<-controlled.send

	hubB.unregister(controlled)
	if _, ok := shared.GetRemoteSession("session-disconnect"); ok {
		t.Fatal("disconnect must delete the shared active session")
	}
	select {
	case payload := <-controller.send:
		var message SignalMessage
		if err := json.Unmarshal(payload, &message); err != nil || message.Type != "close" ||
			message.SessionID != "session-disconnect" {
			t.Fatalf("unexpected disconnect notification: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("remote peer did not receive close after signaling disconnect")
	}
	if err := hubA.forward(SignalMessage{Type: "candidate", From: controller.deviceID,
		To: controlled.deviceID, SessionID: "session-disconnect"}); err == nil {
		t.Fatal("signaling disconnect must invalidate further cross-hub messages")
	}
}

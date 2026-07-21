package state

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"ola-remote-server/internal/signaling"
)

func newTestRedisState(t *testing.T) *RedisState {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return &RedisState{client: client}
}

func concurrentAccepted(total int, attempt func() bool) int64 {
	var accepted atomic.Int64
	var workers sync.WaitGroup
	workers.Add(total)
	for range total {
		go func() {
			defer workers.Done()
			if attempt() {
				accepted.Add(1)
			}
		}()
	}
	workers.Wait()
	return accepted.Load()
}

func TestRedisLimitersAtomicallyCapConcurrentAttempts(t *testing.T) {
	state := newTestRedisState(t)
	if accepted := concurrentAccepted(100, func() bool {
		return state.ConsumePairingAttempt("pairing-key")
	}); accepted != 5 {
		t.Fatalf("accepted %d pairing attempts, want 5", accepted)
	}
	if accepted := concurrentAccepted(100, func() bool {
		return state.ConsumeAuthAttempt("auth-key")
	}); accepted != 10 {
		t.Fatalf("accepted %d auth attempts, want 10", accepted)
	}
	if accepted := concurrentAccepted(100, func() bool {
		return state.ConsumeRegistrationAttempt("registration-key")
	}); accepted != 5 {
		t.Fatalf("accepted %d registration attempts, want 5", accepted)
	}
}

func TestRedisEphemeralPairingIsConsumedExactlyOnce(t *testing.T) {
	state := newTestRedisState(t)
	if err := state.SaveEphemeralPairing("ABCD1234", "device-a", time.Minute); err != nil {
		t.Fatal(err)
	}
	var consumed atomic.Int64
	var workers sync.WaitGroup
	workers.Add(50)
	for range 50 {
		go func() {
			defer workers.Done()
			deviceID, _, err := state.ConsumeEphemeralPairing("ABCD1234")
			if err == nil {
				if deviceID != "device-a" {
					t.Errorf("unexpected device %q", deviceID)
				}
				consumed.Add(1)
			}
		}()
	}
	workers.Wait()
	if consumed.Load() != 1 {
		t.Fatalf("pairing code consumed %d times, want exactly once", consumed.Load())
	}
}

func TestRedisRevokeFailsClosedAndClearsPermission(t *testing.T) {
	state := newTestRedisState(t)
	state.SetDeviceRemoteAllowed("device-a", true)
	state.TouchDevice("device-a")
	if !state.IsDeviceRemoteAllowed("device-a") || !state.IsDeviceOnline("device-a") {
		t.Fatal("expected live allowed device lease")
	}
	state.RevokeDevice("device-a")
	if state.IsDeviceRemoteAllowed("device-a") {
		t.Fatal("revoke must clear remote permission")
	}
	if _, revoked := state.RevokedAt("device-a"); !revoked {
		t.Fatal("revoke timestamp was not persisted")
	}

	expiresAt := time.Now().Add(time.Minute)
	state.RevokeAccountToken("token-a", expiresAt)
	if !state.IsAccountTokenRevoked("token-a") {
		t.Fatal("account token revocation was not persisted")
	}

	if err := state.client.FlushAll(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
}

func TestRedisTicketAndSessionStateAreSharedAndRevokedAtomically(t *testing.T) {
	state := newTestRedisState(t)
	if consumed := concurrentAccepted(50, func() bool {
		return state.ConsumeRemoteTicket("ticket-a", time.Now().Add(time.Minute))
	}); consumed != 1 {
		t.Fatalf("ticket consumed %d times, want exactly once", consumed)
	}

	session := signaling.SharedAuthorizedSession{
		ID: "session-a", AccountID: "account-a", Controller: "controller-a",
		Controlled: "controlled-b", StartedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := state.SaveRemoteSession(session); err != nil {
		t.Fatal(err)
	}
	if err := state.SaveRemoteSession(session); err == nil {
		t.Fatal("duplicate shared session ID must not overwrite the original")
	}
	deviceIndex := remoteDeviceSessionsPrefix + session.Controller
	longTTL, err := state.client.PTTL(context.Background(), deviceIndex).Result()
	if err != nil {
		t.Fatal(err)
	}
	if longTTL < 59*time.Minute {
		t.Fatalf("device session index lease is unexpectedly short: %s", longTTL)
	}
	loaded, ok := state.GetRemoteSession(session.ID)
	if !ok || loaded.Controller != session.Controller || loaded.Controlled != session.Controlled {
		t.Fatalf("unexpected shared session: %#v, %v", loaded, ok)
	}
	state.RevokeDevice(session.Controlled)
	if _, ok := state.GetRemoteSession(session.ID); ok {
		t.Fatal("device revoke must delete shared active sessions")
	}
	var sessionCounter int64
	if accepted := concurrentAccepted(50, func() bool {
		index := atomic.AddInt64(&sessionCounter, 1)
		candidate := signaling.SharedAuthorizedSession{
			ID: fmt.Sprintf("exclusive-%d", index), AccountID: "account-a",
			Controller: fmt.Sprintf("controller-%d", index), Controlled: "controlled-exclusive",
			StartedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
		}
		return state.SaveRemoteSession(candidate) == nil
	}); accepted != 1 {
		t.Fatalf("shared controlled device accepted %d concurrent sessions, want exactly one", accepted)
	}
}

func TestRedisSignalAndRevocationSubscriptionsAreReadyBeforeDelivery(t *testing.T) {
	state := newTestRedisState(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signalReady := make(chan struct{})
	revocationReady := make(chan struct{})
	signals := make(chan string, 1)
	revocations := make(chan string, 1)
	go state.SubscribeSignals(ctx, func(payload []byte) { signals <- string(payload) }, signalReady)
	go state.SubscribeRevocations(ctx, func(deviceID string) { revocations <- deviceID }, revocationReady)
	select {
	case <-signalReady:
	case <-time.After(time.Second):
		t.Fatal("signal subscription did not become ready")
	}
	select {
	case <-revocationReady:
	case <-time.After(time.Second):
		t.Fatal("revocation subscription did not become ready")
	}
	if err := state.PublishSignal([]byte(`{"type":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	state.RevokeDevice("device-a")
	select {
	case payload := <-signals:
		if payload != `{"type":"ping"}` {
			t.Fatalf("unexpected shared signal %q", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("shared signal was not delivered")
	}
	select {
	case deviceID := <-revocations:
		if deviceID != "device-a" {
			t.Fatalf("unexpected revoked device %q", deviceID)
		}
	case <-time.After(time.Second):
		t.Fatal("revocation was not delivered")
	}
}

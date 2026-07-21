package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ola-remote-server/internal/config"
	"ola-remote-server/internal/store"
)

type revokeRecorder struct{ deviceIDs []string }

func (r *revokeRecorder) RevokeDevice(deviceID string) {
	r.deviceIDs = append(r.deviceIDs, deviceID)
}

func requestJSON(t *testing.T, handler http.Handler, method, path string, body any, token string) map[string]any {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	var result map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode response (%d): %v: %s", recorder.Code, err, recorder.Body.String())
	}
	result["_status"] = float64(recorder.Code)
	return result
}

func registerAccountAndDevice(t *testing.T, handler http.Handler, email string) (string, string) {
	t.Helper()
	authResult := requestJSON(t, handler, http.MethodPost, "/api/auth/register", map[string]any{
		"email": email, "password": "test-password", "displayName": email,
	}, "")
	token, _ := authResult["token"].(string)
	if token == "" {
		t.Fatalf("registration failed: %#v", authResult)
	}
	deviceResult := requestJSON(t, handler, http.MethodPost, "/api/devices/register", map[string]any{
		"deviceName": "Test device", "platform": "test", "fingerprint": email,
	}, token)
	device, _ := deviceResult["device"].(map[string]any)
	deviceID, _ := device["id"].(string)
	if deviceID == "" {
		t.Fatalf("device registration failed: %#v", deviceResult)
	}
	return token, deviceID
}

func testConfig() config.Config {
	return config.Config{
		JWTSecret: "test-secret", PairingTTL: time.Minute,
		DeviceTokenTTL: time.Minute, SessionTTL: time.Minute,
	}
}

func TestSignalingTokenRequiresDeviceOwnership(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	tokenA, deviceA := registerAccountAndDevice(t, handler, "a@example.com")
	tokenB, _ := registerAccountAndDevice(t, handler, "b@example.com")

	owned := requestJSON(t, handler, http.MethodPost, "/api/devices/"+deviceA+"/signaling-token", map[string]any{}, tokenA)
	if owned["_status"] != float64(http.StatusOK) || owned["token"] == "" {
		t.Fatalf("owner should receive a signaling token: %#v", owned)
	}
	foreign := requestJSON(t, handler, http.MethodPost, "/api/devices/"+deviceA+"/signaling-token", map[string]any{}, tokenB)
	if foreign["_status"] != float64(http.StatusNotFound) {
		t.Fatalf("foreign account should be rejected: %#v", foreign)
	}
}

func TestRevokeNotifiesSignalingHub(t *testing.T) {
	revoker := &revokeRecorder{}
	handler := NewRouter(testConfig(), store.NewMemoryStore(), revoker)
	token, deviceID := registerAccountAndDevice(t, handler, "owner@example.com")
	result := requestJSON(t, handler, http.MethodPost, "/api/pairing/revoke", map[string]any{
		"deviceId": deviceID,
	}, token)
	if result["_status"] != float64(http.StatusOK) {
		t.Fatalf("revoke failed: %#v", result)
	}
	if len(revoker.deviceIDs) != 1 || revoker.deviceIDs[0] != deviceID {
		t.Fatalf("expected device revocation callback, got %#v", revoker.deviceIDs)
	}
}

func TestResolvePairingRateLimitsInvalidAttempts(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	token, deviceID := registerAccountAndDevice(t, handler, "limited@example.com")
	body := map[string]any{"code": "ABCD-2345", "controllerDeviceId": deviceID, "sessionId": "session-1"}
	for attempt := 0; attempt < pairingFailureLimit; attempt++ {
		result := requestJSON(t, handler, http.MethodPost, "/api/pairing/resolve", body, token)
		if result["_status"] != float64(http.StatusBadRequest) {
			t.Fatalf("attempt %d should be rejected as invalid: %#v", attempt+1, result)
		}
	}
	limited := requestJSON(t, handler, http.MethodPost, "/api/pairing/resolve", body, token)
	if limited["_status"] != float64(http.StatusTooManyRequests) {
		t.Fatalf("expected invalid attempts to be rate limited: %#v", limited)
	}
}

func TestResolvePairingValidatesIdentifiersBeforeConsumingCode(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	controlledToken, controlledDeviceID := registerAccountAndDevice(t, handler, "controlled@example.com")
	controllerToken, controllerDeviceID := registerAccountAndDevice(t, handler, "controller@example.com")

	created := requestJSON(t, handler, http.MethodPost, "/api/pairing/create", map[string]any{
		"deviceId": controlledDeviceID,
	}, controlledToken)
	code, _ := created["code"].(string)
	if created["_status"] != float64(http.StatusOK) || code == "" {
		t.Fatalf("pairing code creation failed: %#v", created)
	}

	invalid := requestJSON(t, handler, http.MethodPost, "/api/pairing/resolve", map[string]any{
		"code": code, "controllerDeviceId": controllerDeviceID, "sessionId": strings.Repeat("x", 129),
	}, controllerToken)
	if invalid["_status"] != float64(http.StatusBadRequest) {
		t.Fatalf("oversized session ID should be rejected: %#v", invalid)
	}

	valid := requestJSON(t, handler, http.MethodPost, "/api/pairing/resolve", map[string]any{
		"code": code, "controllerDeviceId": controllerDeviceID, "sessionId": "session-valid",
	}, controllerToken)
	if valid["_status"] != float64(http.StatusOK) || valid["sessionId"] != "session-valid" {
		t.Fatalf("invalid request must not consume the pairing code: %#v", valid)
	}
}

func TestLogoutImmediatelyRevokesAccountToken(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	token, _ := registerAccountAndDevice(t, handler, "logout@example.com")
	logout := requestJSON(t, handler, http.MethodPost, "/api/auth/logout", map[string]any{}, token)
	if logout["_status"] != float64(http.StatusOK) {
		t.Fatalf("logout failed: %#v", logout)
	}
	me := requestJSON(t, handler, http.MethodGet, "/api/auth/me", map[string]any{}, token)
	if me["_status"] != float64(http.StatusUnauthorized) {
		t.Fatalf("logged-out token must be rejected immediately: %#v", me)
	}
}

func TestLoginFailuresAreRateLimitedWithoutAccountEnumeration(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	requestJSON(t, handler, http.MethodPost, "/api/auth/register", map[string]any{
		"email": "login-limit@example.com", "password": "correct-password", "displayName": "Limited",
	}, "")
	for attempt := 0; attempt < authFailureLimit; attempt++ {
		result := requestJSON(t, handler, http.MethodPost, "/api/auth/login", map[string]any{
			"email": "login-limit@example.com", "password": "wrong-password",
		}, "")
		if result["_status"] != float64(http.StatusUnauthorized) || result["error"] != "invalid email or password" {
			t.Fatalf("attempt %d should return a generic authentication error: %#v", attempt+1, result)
		}
	}
	limited := requestJSON(t, handler, http.MethodPost, "/api/auth/login", map[string]any{
		"email": "login-limit@example.com", "password": "correct-password",
	}, "")
	if limited["_status"] != float64(http.StatusTooManyRequests) {
		t.Fatalf("expected login attempts to be rate limited: %#v", limited)
	}
}

func TestRegistrationAttemptsAreRateLimitedPerDirectClient(t *testing.T) {
	handler := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	for attempt := 0; attempt < registrationAttemptLimit; attempt++ {
		result := requestJSON(t, handler, http.MethodPost, "/api/auth/register", map[string]any{
			"email":    fmt.Sprintf("registration-%d@example.com", attempt),
			"password": "test-password", "displayName": "Test",
		}, "")
		if result["_status"] != float64(http.StatusOK) {
			t.Fatalf("registration %d should succeed: %#v", attempt+1, result)
		}
	}
	limited := requestJSON(t, handler, http.MethodPost, "/api/auth/register", map[string]any{
		"email": "registration-limited@example.com", "password": "test-password", "displayName": "Test",
	}, "")
	if limited["_status"] != float64(http.StatusTooManyRequests) {
		t.Fatalf("expected registrations to be rate limited: %#v", limited)
	}
}

func TestSessionAuditQueryIsAuthenticatedAndAccountScoped(t *testing.T) {
	st := store.NewMemoryStore()
	handler := NewRouter(testConfig(), st, nil)
	tokenA, deviceA := registerAccountAndDevice(t, handler, "audit-a@example.com")
	_, deviceB := registerAccountAndDevice(t, handler, "audit-b@example.com")
	accountA, ok := st.GetDevice(deviceA)
	if !ok {
		t.Fatal("account A device missing")
	}
	accountB, ok := st.GetDevice(deviceB)
	if !ok {
		t.Fatal("account B device missing")
	}
	now := time.Now()
	if err := st.RemoteSessionStarted("session-a", accountA.AccountID, deviceA, deviceB, now); err != nil {
		t.Fatal(err)
	}
	if err := st.RemoteSessionUpdated("session-a", "turn", 8192, now); err != nil {
		t.Fatal(err)
	}
	if err := st.RemoteSessionStarted("session-b", accountB.AccountID, deviceB, deviceA, now); err != nil {
		t.Fatal(err)
	}

	unauthorized := requestJSON(t, handler, http.MethodGet, "/api/sessions", map[string]any{}, "")
	if unauthorized["_status"] != float64(http.StatusUnauthorized) {
		t.Fatalf("session audits must require authentication: %#v", unauthorized)
	}
	result := requestJSON(t, handler, http.MethodGet, "/api/sessions", map[string]any{}, tokenA)
	sessions, _ := result["sessions"].([]any)
	if result["_status"] != float64(http.StatusOK) || len(sessions) != 1 {
		t.Fatalf("expected one account-scoped audit: %#v", result)
	}
	audit, _ := sessions[0].(map[string]any)
	if audit["sessionId"] != "session-a" || audit["transport"] != "turn" || audit["bytesTransferred"] != float64(8192) {
		t.Fatalf("unexpected audit payload: %#v", audit)
	}
}

func TestCORSIsClosedInProductionAndLocalOnlyInDevelopment(t *testing.T) {
	production := NewRouter(testConfig(), store.NewMemoryStore(), nil)
	request := httptest.NewRequest(http.MethodOptions, "/api/auth/login", nil)
	request.Header.Set("Origin", "https://attacker.example")
	recorder := httptest.NewRecorder()
	production.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || recorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("production CORS must fail closed: status=%d headers=%v", recorder.Code, recorder.Header())
	}

	developmentConfig := testConfig()
	developmentConfig.DevelopmentMode = true
	development := NewRouter(developmentConfig, store.NewMemoryStore(), nil)
	request = httptest.NewRequest(http.MethodOptions, "/api/auth/login", nil)
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	recorder = httptest.NewRecorder()
	development.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || recorder.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:5173" {
		t.Fatalf("local development origin should be allowed: status=%d headers=%v", recorder.Code, recorder.Header())
	}
}

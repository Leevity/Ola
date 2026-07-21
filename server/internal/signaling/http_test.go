package signaling

import (
	"net/http/httptest"
	"testing"
)

func TestSignalingCredentialsPreferWebSocketSubprotocol(t *testing.T) {
	request := httptest.NewRequest("GET", "http://example/ws/signaling?token=query-token", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "ola-remote-v1, ola-token.header-token")
	token, protocol := signalingCredentials(request)
	if token != "header-token" || protocol != signalingProtocol {
		t.Fatalf("unexpected credentials token=%q protocol=%q", token, protocol)
	}
}

func TestSignalingCredentialsRetainNonBrowserFallbacks(t *testing.T) {
	request := httptest.NewRequest("GET", "http://example/ws/signaling?token=query-token", nil)
	token, protocol := signalingCredentials(request)
	if token != "query-token" || protocol != "" {
		t.Fatalf("unexpected query fallback token=%q protocol=%q", token, protocol)
	}

	request = httptest.NewRequest("GET", "http://example/ws/signaling", nil)
	request.Header.Set("Authorization", "Bearer bearer-token")
	token, protocol = signalingCredentials(request)
	if token != "bearer-token" || protocol != "" {
		t.Fatalf("unexpected bearer fallback token=%q protocol=%q", token, protocol)
	}
}

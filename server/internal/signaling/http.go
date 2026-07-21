package signaling

import (
	"log"
	"net/http"
	"strings"

	"ola-remote-server/internal/auth"
)

const signalingProtocol = "ola-remote-v1"
const signalingTokenProtocolPrefix = "ola-token."

func signalingCredentials(r *http.Request) (string, string) {
	protocols := strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",")
	selectedProtocol := ""
	token := ""
	for _, rawProtocol := range protocols {
		protocol := strings.TrimSpace(rawProtocol)
		if protocol == signalingProtocol {
			selectedProtocol = signalingProtocol
		} else if strings.HasPrefix(protocol, signalingTokenProtocolPrefix) {
			token = strings.TrimPrefix(protocol, signalingTokenProtocolPrefix)
		}
	}
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token == "" {
		header := r.Header.Get("Authorization")
		if strings.HasPrefix(header, "Bearer ") {
			token = strings.TrimPrefix(header, "Bearer ")
		}
	}
	return token, selectedProtocol
}

func NewHandler(secret []byte, hub *Hub) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws/signaling", func(w http.ResponseWriter, r *http.Request) {
		token, responseProtocol := signalingCredentials(r)
		claims, err := auth.ParseDeviceToken(secret, token)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		conn, err := AcceptWebSocket(w, r, responseProtocol)
		if err != nil {
			log.Printf("websocket accept failed: %v", err)
			return
		}
		client := hub.Register(claims.DeviceID, conn)
		log.Printf("signaling device connected: %s", claims.DeviceID)
		client.Run()
		log.Printf("signaling device disconnected: %s", claims.DeviceID)
	})
	return mux
}

package meshclient

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOrCreateIdentityIsStableAndSignsManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node", "identity.json")
	first, err := LoadOrCreateIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreateIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.PublicKey, second.PublicKey) || !bytes.Equal(first.PrivateKey, second.PrivateKey) {
		t.Fatal("identity changed between loads")
	}
	manifest := struct {
		DeviceID       string       `json:"deviceId"`
		Platform       string       `json:"platform"`
		Runtime        string       `json:"runtime"`
		RuntimeVersion string       `json:"runtimeVersion"`
		PublicKey      string       `json:"publicKey"`
		Capabilities   []Capability `json:"capabilities"`
	}{"device-1", "linux", "ola-node", "1", base64.RawURLEncoding.EncodeToString(first.PublicKey), []Capability{{ID: "system.info", Risk: "low", Version: "1"}}}
	bytes, _ := json.Marshal(manifest)
	digest := sha256Bytes(bytes)
	if !ed25519.Verify(first.PublicKey, digest, ed25519.Sign(first.PrivateKey, digest)) {
		t.Fatal("identity signature did not verify")
	}
	if info, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		t.Fatalf("identity file is not private: info=%v err=%v", info, err)
	}
}

func TestClientRejectsNonTLSExceptLocalhostAndSendsBearer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing bearer token")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nodes":[]}`))
	}))
	defer server.Close()
	client := Client{BaseURL: "http://example.com", Token: "token"}
	if _, err := client.ListNodes(context.Background()); err == nil {
		t.Fatal("insecure remote URL should be rejected")
	}
	client = Client{BaseURL: server.URL, Token: "token", HTTP: server.Client()}
	if _, err := client.ListNodes(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func sha256Bytes(value []byte) []byte {
	// Keep the test independent from the server auth package while exercising
	// the exact digest boundary used by the Node client.
	imported := sha256.Sum256(value)
	return imported[:]
}

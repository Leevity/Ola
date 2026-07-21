package httpapi

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestIssueTURNCredentialsUsesShortLivedHMAC(t *testing.T) {
	before := time.Now().Add(9 * time.Minute).Unix()
	username, credential := issueTURNCredentials("turn-test-secret", "device-a", 10*time.Minute)
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] != "device-a" {
		t.Fatalf("unexpected TURN username: %q", username)
	}
	expires, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || expires < before || expires > time.Now().Add(11*time.Minute).Unix() {
		t.Fatalf("unexpected TURN expiry: %q", parts[0])
	}
	mac := hmac.New(sha1.New, []byte("turn-test-secret"))
	_, _ = mac.Write([]byte(username))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(credential), []byte(expected)) {
		t.Fatal("TURN credential must be HMAC-SHA1 of the expiring username")
	}
}

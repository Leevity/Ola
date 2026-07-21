package httpapi

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

func issueTURNCredentials(secret, subject string, ttl time.Duration) (string, string) {
	expires := time.Now().Add(ttl).Unix()
	username := fmt.Sprintf("%d:%s", expires, subject)
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

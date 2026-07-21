package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const maxSignedTokenBytes = 8192

type Claims struct {
	AccountID string `json:"accountId"`
	Email     string `json:"email"`
	ID        string `json:"jti"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

func IssueToken(secret []byte, accountID string, email string) (string, error) {
	now := time.Now()
	claims := Claims{AccountID: accountID, Email: email, ID: randomTokenID(),
		IssuedAt: now.Unix(), ExpiresAt: now.Add(24 * time.Hour).Unix()}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	sig := sign(secret, encodedPayload)
	return encodedPayload + "." + sig, nil
}

func ParseToken(secret []byte, tokenText string) (*Claims, error) {
	if len(tokenText) == 0 || len(tokenText) > maxSignedTokenBytes {
		return nil, errors.New("invalid token")
	}
	parts := strings.Split(tokenText, ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid token")
	}
	if !hmac.Equal([]byte(sign(secret, parts[0])), []byte(parts[1])) {
		return nil, errors.New("invalid token signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, err
	}
	if claims.ExpiresAt < time.Now().Unix() {
		return nil, errors.New("token expired")
	}
	return &claims, nil
}

func sign(secret []byte, payload string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func issueSigned(secret []byte, claims any) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	return encodedPayload + "." + sign(secret, encodedPayload), nil
}

func parseSigned(secret []byte, tokenText string, target any) error {
	if len(tokenText) == 0 || len(tokenText) > maxSignedTokenBytes {
		return errors.New("invalid token signature")
	}
	parts := strings.Split(tokenText, ".")
	if len(parts) != 2 || !hmac.Equal([]byte(sign(secret, parts[0])), []byte(parts[1])) {
		return errors.New("invalid token signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, target)
}

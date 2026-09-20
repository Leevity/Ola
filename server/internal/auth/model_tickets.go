package auth

import (
	"errors"
	"strings"
	"time"
)

// ModelAccessClaims is the only credential a model gateway request may carry.
// It binds the request to an account, device, workspace, resource and session.
type ModelAccessClaims struct {
	AccountID     string `json:"accountId"`
	ParentTokenID string `json:"parentTokenId"`
	DeviceID      string `json:"deviceId"`
	WorkspaceID   string `json:"workspaceId"`
	ResourceID    string `json:"resourceId"`
	SessionID     string `json:"sessionId"`
	Model         string `json:"model"`
	IssuedAt      int64  `json:"issuedAt"`
	ExpiresAt     int64  `json:"expiresAt"`
}

func IssueModelAccessTicket(secret []byte, claims ModelAccessClaims, ttl time.Duration) (string, error) {
	if ttl <= 0 || !validModelClaim(claims.AccountID) || !validModelClaim(claims.ParentTokenID) || !validModelClaim(claims.DeviceID) ||
		!validModelClaim(claims.WorkspaceID) || !validModelClaim(claims.ResourceID) ||
		!validModelClaim(claims.SessionID) || !validModelClaim(claims.Model) {
		return "", errors.New("invalid model access claims")
	}
	now := time.Now()
	claims.IssuedAt = now.Unix()
	claims.ExpiresAt = now.Add(ttl).Unix()
	return issueSigned(secret, claims)
}

func ParseModelAccessTicket(secret []byte, tokenText string) (*ModelAccessClaims, error) {
	var claims ModelAccessClaims
	if err := parseSigned(secret, tokenText, &claims); err != nil {
		return nil, err
	}
	if claims.ExpiresAt <= time.Now().Unix() || claims.IssuedAt <= 0 ||
		!validModelClaim(claims.AccountID) || !validModelClaim(claims.ParentTokenID) || !validModelClaim(claims.DeviceID) ||
		!validModelClaim(claims.WorkspaceID) || !validModelClaim(claims.ResourceID) ||
		!validModelClaim(claims.SessionID) || !validModelClaim(claims.Model) {
		return nil, errors.New("invalid model access claims")
	}
	return &claims, nil
}

func validModelClaim(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && len(trimmed) <= 1024 && !strings.ContainsAny(trimmed, "\r\n")
}

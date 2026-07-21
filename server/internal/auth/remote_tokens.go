package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

const (
	PurposeDeviceSignaling = "device-signaling"
	PurposeRemoteSession   = "remote-session"
)

type DeviceTokenClaims struct {
	Purpose   string `json:"purpose"`
	AccountID string `json:"accountId"`
	DeviceID  string `json:"deviceId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type RemoteSessionClaims struct {
	Purpose           string `json:"purpose"`
	ID                string `json:"jti"`
	ControllerAccount string `json:"controllerAccountId"`
	ControllerDevice  string `json:"controllerDeviceId"`
	ControllerName    string `json:"controllerDeviceName,omitempty"`
	ControlledDevice  string `json:"controlledDeviceId"`
	SessionID         string `json:"sessionId"`
	IssuedAt          int64  `json:"issuedAt"`
	ExpiresAt         int64  `json:"expiresAt"`
}

func IssueDeviceToken(secret []byte, accountID string, deviceID string, ttl time.Duration) (string, error) {
	if accountID == "" || deviceID == "" || ttl <= 0 {
		return "", errors.New("invalid device token parameters")
	}
	return issueSigned(secret, DeviceTokenClaims{
		Purpose: PurposeDeviceSignaling, AccountID: accountID, DeviceID: deviceID,
		ExpiresAt: time.Now().Add(ttl).Unix(),
	})
}

func ParseDeviceToken(secret []byte, tokenText string) (*DeviceTokenClaims, error) {
	var claims DeviceTokenClaims
	if err := parseSigned(secret, tokenText, &claims); err != nil {
		return nil, err
	}
	if claims.Purpose != PurposeDeviceSignaling || claims.AccountID == "" || claims.DeviceID == "" {
		return nil, errors.New("invalid device token claims")
	}
	if claims.ExpiresAt < time.Now().Unix() {
		return nil, errors.New("device token expired")
	}
	return &claims, nil
}

func IssueRemoteSessionTicket(secret []byte, claims RemoteSessionClaims, ttl time.Duration) (string, error) {
	if claims.ControllerAccount == "" || claims.ControllerDevice == "" ||
		claims.ControlledDevice == "" || claims.SessionID == "" || ttl <= 0 {
		return "", errors.New("invalid remote session ticket parameters")
	}
	claims.Purpose = PurposeRemoteSession
	claims.IssuedAt = time.Now().UnixMilli()
	claims.ExpiresAt = time.Now().Add(ttl).Unix()
	if claims.ID == "" {
		claims.ID = randomTokenID()
	}
	return issueSigned(secret, claims)
}

func ParseRemoteSessionTicket(secret []byte, tokenText string) (*RemoteSessionClaims, error) {
	var claims RemoteSessionClaims
	if err := parseSigned(secret, tokenText, &claims); err != nil {
		return nil, err
	}
	if claims.Purpose != PurposeRemoteSession || claims.ID == "" || claims.ControllerDevice == "" ||
		claims.ControlledDevice == "" || claims.SessionID == "" {
		return nil, errors.New("invalid remote session ticket claims")
	}
	if claims.ExpiresAt < time.Now().Unix() {
		return nil, errors.New("remote session ticket expired")
	}
	return &claims, nil
}

func randomTokenID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(value)
}

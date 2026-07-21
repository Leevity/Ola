package auth

import (
	"strings"
	"testing"
	"time"
)

func TestDeviceTokenBindsAccountAndDevice(t *testing.T) {
	token, err := IssueDeviceToken([]byte("test-secret"), "account-a", "device-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ParseDeviceToken([]byte("test-secret"), token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.AccountID != "account-a" || claims.DeviceID != "device-a" {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if _, err := ParseDeviceToken([]byte("other-secret"), token); err == nil {
		t.Fatal("expected a token signed by another secret to be rejected")
	}
}

func TestSignedTokensRejectOversizedInput(t *testing.T) {
	oversized := strings.Repeat("a", maxSignedTokenBytes+1)
	if _, err := ParseDeviceToken([]byte("test-secret"), oversized); err == nil {
		t.Fatal("expected oversized device token to be rejected")
	}
	if _, err := ParseRemoteSessionTicket([]byte("test-secret"), oversized); err == nil {
		t.Fatal("expected oversized session ticket to be rejected")
	}
	if _, err := ParseToken([]byte("test-secret"), oversized); err == nil {
		t.Fatal("expected oversized account token to be rejected")
	}
}

func TestRemoteSessionTicketBindsParticipantsAndSession(t *testing.T) {
	token, err := IssueRemoteSessionTicket([]byte("test-secret"), RemoteSessionClaims{
		ControllerAccount: "account-a",
		ControllerDevice:  "controller-a",
		ControlledDevice:  "controlled-b",
		SessionID:         "session-1",
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ParseRemoteSessionTicket([]byte("test-secret"), token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.ID == "" || claims.ControllerDevice != "controller-a" ||
		claims.ControlledDevice != "controlled-b" || claims.SessionID != "session-1" {
		t.Fatalf("unexpected claims: %#v", claims)
	}

	tampered := token[:len(token)-1] + "x"
	if _, err := ParseRemoteSessionTicket([]byte("test-secret"), tampered); err == nil {
		t.Fatal("expected a tampered ticket to be rejected")
	}
}

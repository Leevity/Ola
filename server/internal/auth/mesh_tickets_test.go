package auth

import (
	"strings"
	"testing"
	"time"
)

func TestMeshCapabilityTicketIsBoundAndVerifiableWithPublicKey(t *testing.T) {
	secret := []byte("this-is-a-long-enough-test-secret-for-mesh-tickets")
	ticket, err := IssueMeshCapabilityTicket(secret, MeshCapabilityClaims{
		AccountID: "account", SubjectNodeID: "phone", TargetNodeID: "desktop",
		SessionID: "session", Capabilities: []string{"agent.run.readonly"},
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := ParseMeshCapabilityTicket(MeshControlPlanePublicKey(secret), ticket)
	if err != nil {
		t.Fatal(err)
	}
	if claims.TargetNodeID != "desktop" || claims.SubjectNodeID != "phone" || claims.Nonce == "" {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if _, err := ParseMeshCapabilityTicket(MeshControlPlanePublicKey([]byte("other-secret")), ticket); err == nil {
		t.Fatal("ticket signed by another control plane must be rejected")
	}
	parts := strings.Split(ticket, ".")
	if _, err := ParseMeshCapabilityTicket(MeshControlPlanePublicKey(secret), parts[0]+".invalid"); err == nil {
		t.Fatal("tampered ticket must be rejected")
	}
}

package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const PurposeMeshCapability = "mesh-capability"

// MeshCapabilityClaims is intentionally narrow: a ticket cannot be reused for a
// different target, session, or capability. Target Nodes validate it using only
// the control-plane public key.
type MeshCapabilityClaims struct {
	Purpose       string   `json:"purpose"`
	Protocol      string   `json:"protocolVersion"`
	ID            string   `json:"ticketId"`
	AccountID     string   `json:"accountId"`
	SubjectNodeID string   `json:"subjectNodeId"`
	TargetNodeID  string   `json:"targetNodeId"`
	SessionID     string   `json:"sessionId"`
	Capabilities  []string `json:"capabilities"`
	Nonce         string   `json:"nonce"`
	IssuedAt      int64    `json:"issuedAt"`
	ExpiresAt     int64    `json:"expiresAt"`
}

func meshSigningKey(secret []byte) ed25519.PrivateKey {
	seed := sha256.Sum256(append([]byte("ola-mesh-ticket-v1:"), secret...))
	return ed25519.NewKeyFromSeed(seed[:])
}

func MeshControlPlanePublicKey(secret []byte) string {
	publicKey := meshSigningKey(secret).Public().(ed25519.PublicKey)
	return base64.RawURLEncoding.EncodeToString(publicKey)
}

func IssueMeshCapabilityTicket(secret []byte, claims MeshCapabilityClaims, ttl time.Duration) (string, error) {
	if claims.AccountID == "" || claims.SubjectNodeID == "" || claims.TargetNodeID == "" ||
		claims.SessionID == "" || len(claims.Capabilities) == 0 || ttl <= 0 {
		return "", errors.New("invalid mesh capability ticket parameters")
	}
	for _, capability := range claims.Capabilities {
		if strings.TrimSpace(capability) == "" {
			return "", errors.New("invalid mesh capability")
		}
	}
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	now := time.Now()
	claims.Purpose = PurposeMeshCapability
	claims.Protocol = "v0alpha1"
	claims.ID = randomTokenID()
	claims.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	claims.IssuedAt = now.Unix()
	claims.ExpiresAt = now.Add(ttl).Unix()
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := ed25519.Sign(meshSigningKey(secret), []byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func ParseMeshCapabilityTicket(publicKeyText, ticket string) (*MeshCapabilityClaims, error) {
	if len(ticket) == 0 || len(ticket) > maxSignedTokenBytes {
		return nil, errors.New("invalid mesh capability ticket")
	}
	parts := strings.Split(ticket, ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid mesh capability ticket")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(publicKeyText)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("invalid control plane public key")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, []byte(parts[0]), signature) {
		return nil, errors.New("invalid mesh capability ticket signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("invalid mesh capability ticket")
	}
	var claims MeshCapabilityClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, errors.New("invalid mesh capability ticket")
	}
	if claims.Purpose != PurposeMeshCapability || claims.Protocol != "v0alpha1" || claims.ID == "" ||
		claims.AccountID == "" || claims.SubjectNodeID == "" || claims.TargetNodeID == "" ||
		claims.SessionID == "" || len(claims.Capabilities) == 0 || claims.Nonce == "" ||
		claims.ExpiresAt <= time.Now().Unix() || claims.IssuedAt > time.Now().Add(time.Minute).Unix() {
		return nil, errors.New("invalid or expired mesh capability ticket")
	}
	return &claims, nil
}

// TicketFingerprint supports audit logging without storing bearer ticket content.
func TicketFingerprint(ticket string) string {
	digest := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(digest[:12])
}

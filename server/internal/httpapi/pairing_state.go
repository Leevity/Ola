package httpapi

import "time"

type EphemeralPairingState interface {
	SaveEphemeralPairing(code, deviceID string, ttl time.Duration) error
	ConsumeEphemeralPairing(code string) (deviceID string, expiresAt time.Time, err error)
	RevokeEphemeralPairings(deviceID string) (int, error)
}

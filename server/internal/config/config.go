package config

import (
	"os"
	"time"
)

type Config struct {
	APIAddr           string
	SignalAddr        string
	JWTSecret         string
	PairingTTL        time.Duration
	DeviceTokenTTL    time.Duration
	SessionTTL        time.Duration
	ActiveSessionTTL  time.Duration
	DatabaseURL       string
	RedisAddr         string
	STUNURL           string
	TURNURL           string
	TURNSecret        string
	TURNCredentialTTL time.Duration
	AllowDevSecret    bool
	DevelopmentMode   bool
}

func Load() Config {
	jwtSecret := os.Getenv("OLA_REMOTE_JWT_SECRET")
	allowDevSecret := false
	if jwtSecret == "" {
		jwtSecret = "dev-only-randomize-before-production"
		allowDevSecret = true
	}

	apiAddr := os.Getenv("OLA_REMOTE_API_ADDR")
	if apiAddr == "" {
		apiAddr = ":7300"
	}

	signalAddr := os.Getenv("OLA_REMOTE_SIGNAL_ADDR")
	if signalAddr == "" {
		signalAddr = ":7301"
	}
	stunURL := os.Getenv("OLA_REMOTE_STUN_URL")
	if stunURL == "" {
		stunURL = "stun:stun.l.google.com:19302"
	}

	return Config{
		APIAddr:           apiAddr,
		SignalAddr:        signalAddr,
		JWTSecret:         jwtSecret,
		PairingTTL:        5 * time.Minute,
		DeviceTokenTTL:    15 * time.Minute,
		SessionTTL:        5 * time.Minute,
		ActiveSessionTTL:  12 * time.Hour,
		DatabaseURL:       os.Getenv("OLA_REMOTE_DATABASE_URL"),
		RedisAddr:         os.Getenv("OLA_REMOTE_REDIS_ADDR"),
		STUNURL:           stunURL,
		TURNURL:           os.Getenv("OLA_REMOTE_TURN_URL"),
		TURNSecret:        os.Getenv("OLA_REMOTE_TURN_SECRET"),
		TURNCredentialTTL: 10 * time.Minute,
		AllowDevSecret:    allowDevSecret,
		DevelopmentMode:   os.Getenv("OLA_REMOTE_DEV_MODE") == "1",
	}
}

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"ola-remote-server/internal/config"
	"ola-remote-server/internal/httpapi"
	"ola-remote-server/internal/signaling"
	sharedstate "ola-remote-server/internal/state"
	"ola-remote-server/internal/store"
)

func main() {
	cfg := config.Load()
	if !cfg.DevelopmentMode && len(cfg.JWTSecret) < 32 {
		log.Fatal("OLA_REMOTE_JWT_SECRET must contain at least 32 characters")
	}
	if !cfg.DevelopmentMode && (cfg.TURNURL == "" || cfg.TURNSecret == "") {
		log.Fatal("OLA_REMOTE_TURN_URL and OLA_REMOTE_TURN_SECRET are required in production")
	}
	if cfg.AllowDevSecret {
		if !cfg.DevelopmentMode {
			log.Fatal("OLA_REMOTE_JWT_SECRET is required unless OLA_REMOTE_DEV_MODE=1")
		}
		log.Println("OLA_REMOTE_JWT_SECRET is not set; using development-only JWT secret")
	}
	var st store.Store = store.NewMemoryStore()
	if cfg.DatabaseURL != "" {
		postgresStore, err := store.NewPostgresStore(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("connect PostgreSQL: %v", err)
		}
		defer postgresStore.Close()
		st = postgresStore
		log.Println("Ola Remote persistence: PostgreSQL")
	} else {
		if !cfg.DevelopmentMode {
			log.Fatal("OLA_REMOTE_DATABASE_URL is required unless OLA_REMOTE_DEV_MODE=1")
		}
		log.Println("Ola Remote persistence: in-memory development fallback")
	}
	hub := signaling.NewHub([]byte(cfg.JWTSecret))
	hub.SetActiveSessionTTL(cfg.ActiveSessionTTL)
	if auditor, ok := st.(signaling.SessionAuditor); ok {
		hub.SetSessionAuditor(auditor)
	}
	var revoker httpapi.DeviceSessionRevoker = hub
	if cfg.RedisAddr != "" {
		redisState, err := sharedstate.NewRedisState(context.Background(), cfg.RedisAddr)
		if err != nil {
			log.Fatalf("connect Redis: %v", err)
		}
		defer redisState.Close()
		hub.SetRevocationLookup(redisState)
		hub.SetSharedSessionState(redisState)
		hub.SetSignalPublisher(redisState)
		revocationsReady := make(chan struct{})
		signalsReady := make(chan struct{})
		go redisState.SubscribeRevocations(context.Background(), hub.RevokeDevice, revocationsReady)
		go redisState.SubscribeSignals(context.Background(), hub.DeliverSharedSignal, signalsReady)
		for name, ready := range map[string]<-chan struct{}{
			"revocation": revocationsReady, "signal": signalsReady,
		} {
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				log.Fatalf("Redis %s subscription did not become ready", name)
			}
		}
		revoker = sharedstate.NewCoordinator(hub, redisState)
		log.Println("Ola Remote shared state: Redis")
	} else if !cfg.DevelopmentMode {
		log.Fatal("OLA_REMOTE_REDIS_ADDR is required unless OLA_REMOTE_DEV_MODE=1")
	}
	errors := make(chan error, 2)
	go func() {
		log.Printf("Ola Remote API listening on %s", cfg.APIAddr)
		server := &http.Server{
			Addr: cfg.APIAddr, Handler: httpapi.NewRouter(cfg, st, revoker),
			ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
			WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20,
		}
		errors <- fmt.Errorf("api server: %w", server.ListenAndServe())
	}()
	go func() {
		log.Printf("Ola Remote signaling listening on %s", cfg.SignalAddr)
		server := &http.Server{
			Addr: cfg.SignalAddr, Handler: signaling.NewHandler([]byte(cfg.JWTSecret), hub),
			ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
			MaxHeaderBytes: 1 << 20,
		}
		errors <- fmt.Errorf("signaling server: %w", server.ListenAndServe())
	}()
	log.Fatal(<-errors)
}

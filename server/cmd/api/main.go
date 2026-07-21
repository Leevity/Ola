package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"ola-remote-server/internal/config"
	"ola-remote-server/internal/httpapi"
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
	} else if !cfg.DevelopmentMode {
		log.Fatal("OLA_REMOTE_DATABASE_URL is required unless OLA_REMOTE_DEV_MODE=1")
	}
	var revoker httpapi.DeviceSessionRevoker
	if cfg.RedisAddr != "" {
		redisState, err := sharedstate.NewRedisState(context.Background(), cfg.RedisAddr)
		if err != nil {
			log.Fatalf("connect Redis: %v", err)
		}
		defer redisState.Close()
		revoker = redisState
	} else if !cfg.DevelopmentMode {
		log.Fatal("OLA_REMOTE_REDIS_ADDR is required unless OLA_REMOTE_DEV_MODE=1")
	}
	handler := httpapi.NewRouter(cfg, st, revoker)
	log.Printf("Ola Remote API listening on %s", cfg.APIAddr)
	server := &http.Server{
		Addr: cfg.APIAddr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

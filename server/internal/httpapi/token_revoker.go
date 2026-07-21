package httpapi

import (
	"sync"
	"time"
)

type AccountTokenRevoker interface {
	RevokeAccountToken(id string, expiresAt time.Time)
	IsAccountTokenRevoked(id string) bool
}

type localTokenRevoker struct {
	mu      sync.Mutex
	revoked map[string]time.Time
}

func newLocalTokenRevoker() *localTokenRevoker {
	return &localTokenRevoker{revoked: make(map[string]time.Time)}
}

func (r *localTokenRevoker) RevokeAccountToken(id string, expiresAt time.Time) {
	r.mu.Lock()
	r.revoked[id] = expiresAt
	r.mu.Unlock()
}

func (r *localTokenRevoker) IsAccountTokenRevoked(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for tokenID, expiresAt := range r.revoked {
		if expiresAt.Before(now) {
			delete(r.revoked, tokenID)
		}
	}
	_, revoked := r.revoked[id]
	return revoked
}

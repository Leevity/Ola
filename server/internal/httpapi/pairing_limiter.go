package httpapi

import (
	"sync"
	"time"
)

const pairingFailureLimit = 5
const pairingFailureWindow = 5 * time.Minute

type PairingAttemptLimiter interface {
	ConsumePairingAttempt(key string) bool
	ClearPairingFailures(key string)
}

type localPairingLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

func newLocalPairingLimiter() *localPairingLimiter {
	return &localPairingLimiter{failures: make(map[string][]time.Time)}
}

func (l *localPairingLimiter) active(key string, now time.Time) []time.Time {
	cutoff := now.Add(-pairingFailureWindow)
	entries := l.failures[key]
	first := 0
	for first < len(entries) && entries[first].Before(cutoff) {
		first++
	}
	return append([]time.Time(nil), entries[first:]...)
}

func (l *localPairingLimiter) ConsumePairingAttempt(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := l.active(key, time.Now())
	if len(entries) >= pairingFailureLimit {
		l.failures[key] = entries
		return false
	}
	l.failures[key] = append(entries, time.Now())
	return true
}

func (l *localPairingLimiter) ClearPairingFailures(key string) {
	l.mu.Lock()
	delete(l.failures, key)
	l.mu.Unlock()
}

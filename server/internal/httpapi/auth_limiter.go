package httpapi

import (
	"sync"
	"time"
)

const authFailureLimit = 10
const authFailureWindow = 15 * time.Minute
const registrationAttemptLimit = 5
const registrationAttemptWindow = time.Hour

type AuthAttemptLimiter interface {
	ConsumeAuthAttempt(key string) bool
	ClearAuthFailures(key string)
	ConsumeRegistrationAttempt(key string) bool
}

type localAuthLimiter struct {
	mu            sync.Mutex
	failures      map[string][]time.Time
	registrations map[string][]time.Time
}

func newLocalAuthLimiter() *localAuthLimiter {
	return &localAuthLimiter{
		failures:      make(map[string][]time.Time),
		registrations: make(map[string][]time.Time),
	}
}

func activeAttempts(entries []time.Time, cutoff time.Time) []time.Time {
	first := 0
	for first < len(entries) && entries[first].Before(cutoff) {
		first++
	}
	return append([]time.Time(nil), entries[first:]...)
}

func (l *localAuthLimiter) ConsumeAuthAttempt(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := activeAttempts(l.failures[key], time.Now().Add(-authFailureWindow))
	if len(entries) >= authFailureLimit {
		l.failures[key] = entries
		return false
	}
	l.failures[key] = append(entries, time.Now())
	return true
}

func (l *localAuthLimiter) ClearAuthFailures(key string) {
	l.mu.Lock()
	delete(l.failures, key)
	l.mu.Unlock()
}

func (l *localAuthLimiter) ConsumeRegistrationAttempt(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := activeAttempts(l.registrations[key], time.Now().Add(-registrationAttemptWindow))
	if len(entries) >= registrationAttemptLimit {
		l.registrations[key] = entries
		return false
	}
	l.registrations[key] = append(entries, time.Now())
	return true
}

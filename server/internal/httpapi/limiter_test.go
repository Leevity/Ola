package httpapi

import (
	"sync"
	"sync/atomic"
	"testing"
)

func runConcurrentAttempts(total int, attempt func() bool) int64 {
	var accepted atomic.Int64
	var workers sync.WaitGroup
	workers.Add(total)
	for range total {
		go func() {
			defer workers.Done()
			if attempt() {
				accepted.Add(1)
			}
		}()
	}
	workers.Wait()
	return accepted.Load()
}

func TestLocalPairingLimiterAtomicallyCapsConcurrentAttempts(t *testing.T) {
	limiter := newLocalPairingLimiter()
	if accepted := runConcurrentAttempts(100, func() bool {
		return limiter.ConsumePairingAttempt("account:ip")
	}); accepted != pairingFailureLimit {
		t.Fatalf("accepted %d pairing attempts, want %d", accepted, pairingFailureLimit)
	}
	limiter.ClearPairingFailures("account:ip")
	if !limiter.ConsumePairingAttempt("account:ip") {
		t.Fatal("successful pairing reset must clear the limiter")
	}
}

func TestLocalAuthLimiterAtomicallyCapsConcurrentAttempts(t *testing.T) {
	limiter := newLocalAuthLimiter()
	if accepted := runConcurrentAttempts(100, func() bool {
		return limiter.ConsumeAuthAttempt("login:ip:email")
	}); accepted != authFailureLimit {
		t.Fatalf("accepted %d login attempts, want %d", accepted, authFailureLimit)
	}
	limiter.ClearAuthFailures("login:ip:email")
	if !limiter.ConsumeAuthAttempt("login:ip:email") {
		t.Fatal("successful login reset must clear the limiter")
	}
}

func TestLocalRegistrationLimiterAtomicallyCapsConcurrentAttempts(t *testing.T) {
	limiter := newLocalAuthLimiter()
	if accepted := runConcurrentAttempts(100, func() bool {
		return limiter.ConsumeRegistrationAttempt("register:ip")
	}); accepted != registrationAttemptLimit {
		t.Fatalf("accepted %d registration attempts, want %d", accepted, registrationAttemptLimit)
	}
}

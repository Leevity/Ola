package store

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Account struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	DisplayName string     `json:"displayName"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt,omitempty"`
}

type Device struct {
	ID          string     `json:"id"`
	AccountID   string     `json:"accountId"`
	DeviceName  string     `json:"deviceName"`
	Platform    string     `json:"platform"`
	Fingerprint string     `json:"fingerprint,omitempty"`
	IsOnline    bool       `json:"isOnline"`
	LastSeen    *time.Time `json:"lastSeen,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type PairingCode struct {
	Code      string     `json:"code"`
	DeviceID  string     `json:"deviceId"`
	ExpiresAt time.Time  `json:"expiresAt"`
	UsedAt    *time.Time `json:"usedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

type RemoteSessionAudit struct {
	SessionID           string     `json:"sessionId"`
	ControllerAccountID string     `json:"-"`
	ControllerDeviceID  string     `json:"controllerDeviceId"`
	ControlledDeviceID  string     `json:"controlledDeviceId"`
	StartedAt           time.Time  `json:"startedAt"`
	EndedAt             *time.Time `json:"endedAt,omitempty"`
	DisconnectReason    string     `json:"disconnectReason,omitempty"`
	Transport           string     `json:"transport,omitempty"`
	BytesTransferred    int64      `json:"bytesTransferred"`
	UpdatedAt           *time.Time `json:"updatedAt,omitempty"`
}

type MemoryStore struct {
	mu             sync.RWMutex
	accounts       map[string]Account
	accountsByMail map[string]string
	passwordHashes map[string]string
	devices        map[string]Device
	pairingCodes   map[string]PairingCode
	remoteSessions map[string]RemoteSessionAudit
}

type Store interface {
	RegisterAccount(email string, password string, displayName string) (Account, error)
	Login(email string, password string) (Account, error)
	GetAccount(id string) (Account, bool)
	RegisterDevice(accountID string, name string, platform string, fingerprint string) (Device, error)
	ListDevices(accountID string) []Device
	GetDevice(deviceID string) (Device, bool)
	HeartbeatDevice(accountID string, deviceID string) (Device, error)
	SavePairingCode(code string, deviceID string, ttl time.Duration) (PairingCode, error)
	ResolvePairingCode(code string) (PairingCode, Device, error)
	RevokePairingCodesForDevice(accountID string, deviceID string) (int, error)
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		accounts:       make(map[string]Account),
		accountsByMail: make(map[string]string),
		passwordHashes: make(map[string]string),
		devices:        make(map[string]Device),
		pairingCodes:   make(map[string]PairingCode),
		remoteSessions: make(map[string]RemoteSessionAudit),
	}
}

func (s *MemoryStore) RemoteSessionStarted(sessionID, controllerAccountID, controllerDeviceID, controlledDeviceID string, startedAt time.Time) error {
	if sessionID == "" {
		return errors.New("session ID is required")
	}
	s.mu.Lock()
	s.remoteSessions[sessionID] = RemoteSessionAudit{SessionID: sessionID,
		ControllerAccountID: controllerAccountID, ControllerDeviceID: controllerDeviceID,
		ControlledDeviceID: controlledDeviceID, StartedAt: startedAt}
	s.mu.Unlock()
	return nil
}

func (s *MemoryStore) RemoteSessionEnded(sessionID, reason string, endedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	audit, ok := s.remoteSessions[sessionID]
	if !ok {
		return errors.New("remote session audit not found")
	}
	audit.EndedAt = &endedAt
	audit.DisconnectReason = reason
	s.remoteSessions[sessionID] = audit
	return nil
}

func (s *MemoryStore) RemoteSessionUpdated(sessionID, transport string, bytesTransferred int64, updatedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	audit, ok := s.remoteSessions[sessionID]
	if !ok {
		return errors.New("remote session audit not found")
	}
	if transport == "p2p" || transport == "turn" {
		audit.Transport = transport
	}
	if bytesTransferred > audit.BytesTransferred {
		audit.BytesTransferred = bytesTransferred
	}
	audit.UpdatedAt = &updatedAt
	s.remoteSessions[sessionID] = audit
	return nil
}

func (s *MemoryStore) GetRemoteSessionAudit(sessionID string) (RemoteSessionAudit, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	audit, ok := s.remoteSessions[sessionID]
	return audit, ok
}

func (s *MemoryStore) ListRemoteSessionAudits(accountID string, limit int) ([]RemoteSessionAudit, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]RemoteSessionAudit, 0)
	for _, audit := range s.remoteSessions {
		if audit.ControllerAccountID == accountID {
			result = append(result, audit)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt.After(result[j].StartedAt) })
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemoryStore) RegisterAccount(email string, password string, displayName string) (Account, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || password == "" {
		return Account{}, errors.New("email and password are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.accountsByMail[email]; exists {
		return Account{}, errors.New("account already exists")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return Account{}, err
	}
	account := Account{ID: randomID(), Email: email, DisplayName: displayName, CreatedAt: time.Now()}
	s.accounts[account.ID] = account
	s.accountsByMail[email] = account.ID
	s.passwordHashes[account.ID] = hash
	return account, nil
}

func (s *MemoryStore) Login(email string, password string) (Account, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	s.mu.Lock()
	defer s.mu.Unlock()
	accountID, ok := s.accountsByMail[email]
	if !ok {
		return Account{}, errors.New("invalid credentials")
	}
	if !verifyPassword(s.passwordHashes[accountID], password) {
		return Account{}, errors.New("invalid credentials")
	}
	account := s.accounts[accountID]
	now := time.Now()
	account.LastLoginAt = &now
	s.accounts[account.ID] = account
	return account, nil
}

func (s *MemoryStore) GetAccount(id string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	account, ok := s.accounts[id]
	return account, ok
}

func (s *MemoryStore) RegisterDevice(accountID string, name string, platform string, fingerprint string) (Device, error) {
	if strings.TrimSpace(name) == "" || strings.TrimSpace(platform) == "" {
		return Device{}, errors.New("deviceName and platform are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for _, device := range s.devices {
		if device.AccountID == accountID && device.Fingerprint != "" && device.Fingerprint == fingerprint {
			device.DeviceName = name
			device.Platform = platform
			device.IsOnline = true
			device.LastSeen = &now
			s.devices[device.ID] = device
			return device, nil
		}
	}
	device := Device{
		ID:          randomID(),
		AccountID:   accountID,
		DeviceName:  name,
		Platform:    platform,
		Fingerprint: fingerprint,
		IsOnline:    true,
		LastSeen:    &now,
		CreatedAt:   now,
	}
	s.devices[device.ID] = device
	return device, nil
}

func (s *MemoryStore) ListDevices(accountID string) []Device {
	s.mu.RLock()
	defer s.mu.RUnlock()
	devices := make([]Device, 0)
	for _, device := range s.devices {
		if device.AccountID == accountID {
			devices = append(devices, device)
		}
	}
	return devices
}

func (s *MemoryStore) GetDevice(deviceID string) (Device, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	device, ok := s.devices[deviceID]
	return device, ok
}

func (s *MemoryStore) HeartbeatDevice(accountID string, deviceID string) (Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok || device.AccountID != accountID {
		return Device{}, errors.New("device not found")
	}
	now := time.Now()
	device.IsOnline = true
	device.LastSeen = &now
	s.devices[device.ID] = device
	return device, nil
}

func (s *MemoryStore) SavePairingCode(code string, deviceID string, ttl time.Duration) (PairingCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok {
		return PairingCode{}, errors.New("device not found")
	}
	if !device.IsOnline {
		return PairingCode{}, errors.New("device is offline")
	}
	now := time.Now()
	pairing := PairingCode{Code: code, DeviceID: deviceID, ExpiresAt: now.Add(ttl), CreatedAt: now}
	s.pairingCodes[code] = pairing
	return pairing, nil
}

func (s *MemoryStore) ResolvePairingCode(code string) (PairingCode, Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pairing, ok := s.pairingCodes[code]
	if !ok || pairing.ExpiresAt.Before(time.Now()) || pairing.UsedAt != nil {
		return PairingCode{}, Device{}, errors.New("pairing code is invalid or expired")
	}
	device, ok := s.devices[pairing.DeviceID]
	if !ok || !device.IsOnline {
		return PairingCode{}, Device{}, errors.New("device is unavailable")
	}
	now := time.Now()
	pairing.UsedAt = &now
	s.pairingCodes[code] = pairing
	return pairing, device, nil
}

func (s *MemoryStore) RevokePairingCodesForDevice(accountID string, deviceID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok || device.AccountID != accountID {
		return 0, errors.New("device not found")
	}
	now := time.Now()
	revoked := 0
	for code, pairing := range s.pairingCodes {
		if pairing.DeviceID == deviceID && pairing.UsedAt == nil && pairing.ExpiresAt.After(now) {
			pairing.UsedAt = &now
			s.pairingCodes[code] = pairing
			revoked++
		}
	}
	return revoked, nil
}

func randomID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func verifyPassword(encoded string, password string) bool {
	if strings.HasPrefix(encoded, "$2") {
		return bcrypt.CompareHashAndPassword([]byte(encoded), []byte(password)) == nil
	}
	// Legacy development hashes remain readable so existing local accounts are not locked out.
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	actual := passwordDigest(salt, password)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func passwordDigest(salt []byte, password string) []byte {
	key := []byte(password)
	var digest []byte
	for i := 0; i < 100000; i++ {
		mac := hmac.New(sha256.New, key)
		mac.Write(salt)
		mac.Write(digest)
		digest = mac.Sum(nil)
		key = digest
	}
	return digest
}

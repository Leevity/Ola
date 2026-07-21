package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type PostgresStore struct{ db *sql.DB }

func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, errors.New("database URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	store := &PostgresStore{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *PostgresStore) Close() error { return s.db.Close() }

func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  display_name VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL, platform VARCHAR(40) NOT NULL, device_fingerprint TEXT,
  is_online BOOLEAN NOT NULL DEFAULT false, last_seen TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_account_fingerprint
  ON devices(account_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL AND device_fingerprint <> '';
CREATE TABLE IF NOT EXISTS pairing_codes (
  code VARCHAR(16) PRIMARY KEY, device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS remote_sessions (
  id UUID PRIMARY KEY, client_session_id TEXT, controller_account_id UUID, controller_device_id UUID,
  controlled_device_id UUID, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  transport VARCHAR(20), bytes_transferred BIGINT, disconnect_reason VARCHAR(100)
);
ALTER TABLE remote_sessions ADD COLUMN IF NOT EXISTS client_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_remote_sessions_started ON remote_sessions(started_at);`)
	if err == nil {
		_, err = s.db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_sessions_client_session
  ON remote_sessions(client_session_id) WHERE client_session_id IS NOT NULL`)
	}
	return err
}

func (s *PostgresStore) RemoteSessionStarted(sessionID, controllerAccountID, controllerDeviceID, controlledDeviceID string, startedAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO remote_sessions (id,client_session_id,controller_account_id,controller_device_id,controlled_device_id,started_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (client_session_id) WHERE client_session_id IS NOT NULL DO NOTHING`,
		randomID(), sessionID, controllerAccountID, controllerDeviceID, controlledDeviceID, startedAt,
	)
	return err
}

func (s *PostgresStore) RemoteSessionEnded(sessionID, reason string, endedAt time.Time) error {
	result, err := s.db.Exec(
		`UPDATE remote_sessions SET ended_at=COALESCE(ended_at,$2), disconnect_reason=COALESCE(disconnect_reason,$3)
         WHERE client_session_id=$1`, sessionID, endedAt, reason,
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return errors.New("remote session audit not found")
	}
	return err
}

func (s *PostgresStore) RemoteSessionUpdated(sessionID, transport string, bytesTransferred int64, _ time.Time) error {
	result, err := s.db.Exec(
		`UPDATE remote_sessions SET transport=$2, bytes_transferred=GREATEST(COALESCE(bytes_transferred,0),$3)
         WHERE client_session_id=$1`, sessionID, transport, bytesTransferred,
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return errors.New("remote session audit not found")
	}
	return err
}

func (s *PostgresStore) ListRemoteSessionAudits(accountID string, limit int) ([]RemoteSessionAudit, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.Query(
		`SELECT client_session_id, controller_account_id, controller_device_id, controlled_device_id,
                started_at, ended_at, COALESCE(disconnect_reason,''), COALESCE(transport,''),
                COALESCE(bytes_transferred,0)
           FROM remote_sessions WHERE controller_account_id=$1
          ORDER BY started_at DESC LIMIT $2`, accountID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]RemoteSessionAudit, 0)
	for rows.Next() {
		var audit RemoteSessionAudit
		var endedAt sql.NullTime
		if err := rows.Scan(&audit.SessionID, &audit.ControllerAccountID, &audit.ControllerDeviceID,
			&audit.ControlledDeviceID, &audit.StartedAt, &endedAt, &audit.DisconnectReason,
			&audit.Transport, &audit.BytesTransferred); err != nil {
			return nil, err
		}
		if endedAt.Valid {
			audit.EndedAt = &endedAt.Time
		}
		result = append(result, audit)
	}
	return result, rows.Err()
}

func scanAccount(scanner interface{ Scan(...any) error }) (Account, error) {
	var account Account
	var lastLogin sql.NullTime
	err := scanner.Scan(&account.ID, &account.Email, &account.DisplayName, &account.CreatedAt, &lastLogin)
	if lastLogin.Valid {
		account.LastLoginAt = &lastLogin.Time
	}
	return account, err
}

func scanDevice(scanner interface{ Scan(...any) error }) (Device, error) {
	var device Device
	var fingerprint sql.NullString
	var lastSeen sql.NullTime
	err := scanner.Scan(
		&device.ID, &device.AccountID, &device.DeviceName, &device.Platform, &fingerprint,
		&device.IsOnline, &lastSeen, &device.CreatedAt,
	)
	if fingerprint.Valid {
		device.Fingerprint = fingerprint.String
	}
	if lastSeen.Valid {
		device.LastSeen = &lastSeen.Time
	}
	return device, err
}

const accountColumns = `id, email, COALESCE(display_name, ''), created_at, last_login_at`
const deviceColumns = `id, account_id, device_name, platform, device_fingerprint, is_online, last_seen, created_at`

func (s *PostgresStore) RegisterAccount(email, password, displayName string) (Account, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || password == "" {
		return Account{}, errors.New("email and password are required")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return Account{}, err
	}
	return scanAccount(s.db.QueryRow(
		`INSERT INTO accounts (id, email, password_hash, display_name) VALUES ($1,$2,$3,$4)
         RETURNING `+accountColumns,
		randomID(), email, hash, strings.TrimSpace(displayName),
	))
}

func (s *PostgresStore) Login(email, password string) (Account, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var accountID, encoded string
	if err := s.db.QueryRow(`SELECT id, password_hash FROM accounts WHERE email=$1`, email).Scan(&accountID, &encoded); err != nil {
		return Account{}, errors.New("invalid credentials")
	}
	if !verifyPassword(encoded, password) {
		return Account{}, errors.New("invalid credentials")
	}
	return scanAccount(s.db.QueryRow(
		`UPDATE accounts SET last_login_at=NOW() WHERE id=$1 RETURNING `+accountColumns, accountID,
	))
}

func (s *PostgresStore) GetAccount(id string) (Account, bool) {
	account, err := scanAccount(s.db.QueryRow(`SELECT `+accountColumns+` FROM accounts WHERE id=$1`, id))
	return account, err == nil
}

func (s *PostgresStore) RegisterDevice(accountID, name, platform, fingerprint string) (Device, error) {
	name, platform, fingerprint = strings.TrimSpace(name), strings.TrimSpace(platform), strings.TrimSpace(fingerprint)
	if name == "" || platform == "" {
		return Device{}, errors.New("deviceName and platform are required")
	}
	if fingerprint != "" {
		if device, err := scanDevice(s.db.QueryRow(
			`UPDATE devices SET device_name=$3, platform=$4, is_online=true, last_seen=NOW()
             WHERE account_id=$1 AND device_fingerprint=$2 RETURNING `+deviceColumns,
			accountID, fingerprint, name, platform,
		)); err == nil {
			return device, nil
		}
	}
	return scanDevice(s.db.QueryRow(
		`INSERT INTO devices (id, account_id, device_name, platform, device_fingerprint, is_online, last_seen)
         VALUES ($1,$2,$3,$4,NULLIF($5,''),true,NOW()) RETURNING `+deviceColumns,
		randomID(), accountID, name, platform, fingerprint,
	))
}

func (s *PostgresStore) ListDevices(accountID string) []Device {
	rows, err := s.db.Query(`SELECT `+deviceColumns+` FROM devices WHERE account_id=$1 ORDER BY created_at`, accountID)
	if err != nil {
		return []Device{}
	}
	defer rows.Close()
	devices := make([]Device, 0)
	for rows.Next() {
		device, err := scanDevice(rows)
		if err == nil {
			devices = append(devices, device)
		}
	}
	return devices
}

func (s *PostgresStore) GetDevice(deviceID string) (Device, bool) {
	device, err := scanDevice(s.db.QueryRow(`SELECT `+deviceColumns+` FROM devices WHERE id=$1`, deviceID))
	return device, err == nil
}

func (s *PostgresStore) HeartbeatDevice(accountID, deviceID string) (Device, error) {
	device, err := scanDevice(s.db.QueryRow(
		`UPDATE devices SET is_online=true,last_seen=NOW() WHERE id=$1 AND account_id=$2 RETURNING `+deviceColumns,
		deviceID, accountID,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, errors.New("device not found")
	}
	return device, err
}

func (s *PostgresStore) SavePairingCode(code, deviceID string, ttl time.Duration) (PairingCode, error) {
	var pairing PairingCode
	err := s.db.QueryRow(
		`INSERT INTO pairing_codes (code,device_id,expires_at) VALUES ($1,$2,NOW()+$3::interval)
         RETURNING code,device_id,expires_at,used_at,created_at`,
		code, deviceID, ttl.String(),
	).Scan(&pairing.Code, &pairing.DeviceID, &pairing.ExpiresAt, &pairing.UsedAt, &pairing.CreatedAt)
	return pairing, err
}

func (s *PostgresStore) ResolvePairingCode(code string) (PairingCode, Device, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return PairingCode{}, Device{}, err
	}
	defer tx.Rollback()
	var pairing PairingCode
	var usedAt sql.NullTime
	err = tx.QueryRow(
		`SELECT code,device_id,expires_at,used_at,created_at FROM pairing_codes
         WHERE code=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`, code,
	).Scan(&pairing.Code, &pairing.DeviceID, &pairing.ExpiresAt, &usedAt, &pairing.CreatedAt)
	if err != nil {
		return PairingCode{}, Device{}, errors.New("pairing code is invalid or expired")
	}
	device, err := scanDevice(tx.QueryRow(`SELECT `+deviceColumns+` FROM devices WHERE id=$1 AND is_online=true`, pairing.DeviceID))
	if err != nil {
		return PairingCode{}, Device{}, errors.New("device is unavailable")
	}
	now := time.Now()
	if _, err = tx.Exec(`UPDATE pairing_codes SET used_at=$2 WHERE code=$1`, code, now); err != nil {
		return PairingCode{}, Device{}, err
	}
	if err = tx.Commit(); err != nil {
		return PairingCode{}, Device{}, err
	}
	pairing.UsedAt = &now
	return pairing, device, nil
}

func (s *PostgresStore) RevokePairingCodesForDevice(accountID, deviceID string) (int, error) {
	result, err := s.db.Exec(
		`UPDATE pairing_codes SET used_at=NOW() WHERE device_id=$1 AND used_at IS NULL AND expires_at>NOW()
         AND EXISTS (SELECT 1 FROM devices WHERE id=$1 AND account_id=$2)`,
		deviceID, accountID,
	)
	if err != nil {
		return 0, err
	}
	count, _ := result.RowsAffected()
	device, ok := s.GetDevice(deviceID)
	if !ok || device.AccountID != accountID {
		return 0, errors.New("device not found")
	}
	return int(count), nil
}

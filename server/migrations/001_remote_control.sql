CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,
  platform VARCHAR(20) NOT NULL,
  device_fingerprint TEXT,
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_account_fingerprint
  ON devices(account_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL AND device_fingerprint <> '';

CREATE TABLE IF NOT EXISTS pairing_codes (
  code VARCHAR(9) PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_sessions (
  id UUID PRIMARY KEY,
  client_session_id TEXT,
  controller_account_id UUID,
  controller_device_id UUID,
  controlled_device_id UUID,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  transport VARCHAR(20),
  bytes_transferred BIGINT,
  disconnect_reason VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_remote_sessions_started ON remote_sessions(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_sessions_client_session
  ON remote_sessions(client_session_id)
  WHERE client_session_id IS NOT NULL;

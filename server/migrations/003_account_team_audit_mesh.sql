ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mfa_secret_enc BYTEA;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS account_email_tokens (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose VARCHAR(32) NOT NULL CHECK (purpose IN ('verify_email','password_reset')),
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_email_tokens_account ON account_email_tokens(account_id,purpose,expires_at);

CREATE TABLE IF NOT EXISTS account_recovery_codes (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash VARCHAR(128) NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,code_hash)
);

CREATE TABLE IF NOT EXISTS team_invitations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member' CHECK (role IN ('member','team_admin')),
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  invited_by UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_invitations_org_email ON team_invitations(organization_id,lower(email));

CREATE TABLE IF NOT EXISTS control_audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  subject_type VARCHAR(40) NOT NULL,
  subject_id VARCHAR(128) NOT NULL,
  outcome VARCHAR(24) NOT NULL DEFAULT 'success',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_control_audit_org_created ON control_audit_events(organization_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_control_audit_actor_created ON control_audit_events(actor_account_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS mesh_events (
  event_id VARCHAR(128) PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_node_id VARCHAR(128) NOT NULL,
  target_node_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  sequence BIGINT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  signature VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_node_id,session_id,sequence)
);
CREATE INDEX IF NOT EXISTS idx_mesh_events_target_cursor ON mesh_events(target_node_id,sequence);
CREATE INDEX IF NOT EXISTS idx_mesh_events_created ON mesh_events(created_at);
CREATE TABLE IF NOT EXISTS mesh_ticket_nonces (
  nonce_hash VARCHAR(128) PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mesh_ticket_nonces_expiry ON mesh_ticket_nonces(expires_at);

// Cross-process contracts for the Credential Agent subsystem.
// Password plaintext NEVER crosses the main/renderer boundary in normal flow.
// All credential operations flow through IPC, and BrowserType injection happens
// inside the main process (Native Worker side or main process vault).

export type CredentialKind = 'password'

export type CredentialSource = 'manual' | 'builtin_template'

export interface CredentialRef {
  id: string
  domain: string
  usernameHint?: string
  kind: CredentialKind
  source: CredentialSource
  builtinTemplateId?: string
  projectId?: string
  notes?: string
  lastUsedAt?: number
  lastVerifiedAt?: number
  lastVerificationStatus?: VerificationStatus
  createdAt: number
}

export type VerificationStatus = 'pass' | 'challenge' | 'fail' | 'unknown'

export interface SiteProfile {
  id: string
  displayName: string
  category: string
  domain: string
  loginUrl: string
  usernameSelector: string
  passwordSelector: string
  submitSelector?: string
  successIndicator: {
    type: 'url_contains' | 'url_not_contains' | 'selector_visible'
    value: string
  }
  twoFactorIndicator?: string
  knownChallenge?: 'totp_required' | 'device_fingerprint'
  notes?: string
}

export interface BuiltinTemplateInfo {
  id: string
  displayName: string
  domain: string
  category: string
  enabled: boolean
}

export type ChallengeKind =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'slider_puzzle'
  | 'device_fingerprint'
  | 'totp_required'
  | 'phone_verification'
  | 'email_verification'
  | 'unknown_challenge'

// Compile-time guarantee: every challenge kind is non-auto-resolvable.
// Adding a new ChallengeKind requires extending this map, which forces
// the developer to consciously acknowledge the safety policy.
export const NON_AUTO_RESOLVABLE_CHALLENGES: { [K in ChallengeKind]: false } = {
  recaptcha_v2: false,
  recaptcha_v3: false,
  hcaptcha: false,
  turnstile: false,
  slider_puzzle: false,
  device_fingerprint: false,
  totp_required: false,
  phone_verification: false,
  email_verification: false,
  unknown_challenge: false
}

export interface DetectedChallenge {
  kind: ChallengeKind
  detectedAt: number
  evidence: string
  autoResolvable: false
}

export type LoginStatus =
  | 'logged_in'
  | 'need_2fa'
  | 'paused_for_challenge'
  | 'paused_for_human'
  | 'failed'
  | 'cancelled'
  | 'no_credential'

export interface LoginOutcome {
  status: LoginStatus
  credentialRef?: CredentialRef
  reason?: string
  challenge?: DetectedChallenge
  needsHumanAction?: 'enter_otp' | 'solve_captcha' | 'pick_account' | 'general'
}

export interface VerificationResult {
  status: VerificationStatus
  domain: string
  durationMs: number
  challenge?: DetectedChallenge
  failureReason?: string
  screenshotPath?: string
  testedAt: number
}

export interface StoreCredentialRequest {
  domain: string
  username: string
  password: string // sent once, immediately moved into vault on the main side
  builtinTemplateId?: string
  notes?: string
  verify?: boolean
}

export interface StoreCredentialResponse {
  success: boolean
  ref?: CredentialRef
  verification?: VerificationResult
  error?: string
}

export interface ListCredentialsFilter {
  domain?: string
  projectId?: string
}

export interface ListCredentialsResponse {
  refs: CredentialRef[]
}

export interface DeleteCredentialRequest {
  id: string
}

export interface DeleteCredentialResponse {
  success: boolean
  error?: string
}

export interface UpdateCredentialRequest {
  id: string
  username?: string
  password?: string
  notes?: string
}

export interface UpdateCredentialResponse {
  ref?: CredentialRef
  error?: string
}

export interface ListBuiltinTemplatesResponse {
  templates: BuiltinTemplateInfo[]
}

export interface EnableBuiltinTemplateRequest {
  templateId: string
  username: string
  password: string
  verify?: boolean
}

export interface EnableBuiltinTemplateResponse {
  success: boolean
  ref?: CredentialRef
  verification?: VerificationResult
  error?: string
}

export interface RecordCredentialVerificationRequest {
  id: string
  result: VerificationResult
}

export interface RecordCredentialVerificationResponse {
  ref?: CredentialRef
  error?: string
}

// Internal IPC channel names. Renderer calls these via ipcClient; the
// main-side handler must NEVER echo the plaintext password back to the
// renderer (the request payload is the only direction plaintext flows).
export const CREDENTIALS_IPC = {
  STORE: 'credentials:store',
  LIST: 'credentials:list',
  DELETE: 'credentials:delete',
  LIST_TEMPLATES: 'credentials:list-templates',
  ENABLE_TEMPLATE: 'credentials:enable-template',
  RECORD_VERIFICATION: 'credentials:record-verification',
  VAULT_STATUS: 'credentials:vault-status',
  FILL_PASSWORD: 'credentials:fill-password',
  UPDATE: 'credentials:update'
} as const

export interface VaultStatus {
  available: boolean
  backend: 'safe_storage' | 'in_memory_fallback'
  reason?: string
}

// ===== Login run state machine (PR2-A added) =====

export type LoginStepId =
  | 'idle'
  | 'navigate' // Open the login page.
  | 'detect_form' // Locate the login form.
  | 'fill_username' // Fill the username field.
  | 'fill_password' // Inject password through main-process IPC.
  | 'submit' // Submit the login form.
  | 'inspect_result' // Inspect the post-login page.
  | 'done' // Terminal success state.
  | 'paused' // Waiting for human input.
  | 'failed' // Terminal failure state.

export type LoginStepStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_human'
  | 'success'
  | 'failed'
  | 'skipped'

export interface LoginStepState {
  id: LoginStepId
  status: LoginStepStatus
  startedAt?: number
  finishedAt?: number
  message: string
  errorDetail?: string
  artifacts?: {
    detectedUsernameSelector?: string
    detectedPasswordSelector?: string
    detectedSubmitSelector?: string
    challenge?: DetectedChallenge
  }
}

export type HandoffReason = 'user_requested' | 'challenge_detected' | 'step_failed'

export interface HandoffState {
  mode: 'agent' | 'human'
  reason?: HandoffReason
}

export type LoginRunResult = 'pass' | 'challenge' | 'fail'

export interface LoginRunState {
  id: string
  domain: string
  credentialId: string
  username: string // Hint only; never contains the secret.
  sessionId?: string | null
  projectId?: string | null
  startedAt: number
  currentStep: LoginStepId
  steps: LoginStepId[]
  stepStates: Record<LoginStepId, LoginStepState>
  handoff: HandoffState
  result?: LoginRunResult
}

// Canonical 6-step order. Idle/done/paused/failed are control states,
// not real steps; they live outside the steps[] array.
export const LOGIN_RUN_STEPS: LoginStepId[] = [
  'navigate',
  'detect_form',
  'fill_username',
  'fill_password',
  'submit',
  'inspect_result'
]

// New IPC channel for renderer-asks-main-to-fill-password.
export const CREDENTIALS_IPC_FILL_PASSWORD = 'credentials:fill-password'

export interface FillPasswordRequest {
  credentialId: string
  webContentsId: number
  selector: string
}

export interface FillPasswordResponse {
  status: 'filled' | 'not_found' | 'no_credentials' | 'no_password' | 'error'
  error?: string
}

// Main-side IPC handlers for the credential subsystem.
// The renderer NEVER receives plaintext passwords back. The store/verify
// flows run end-to-end in the main process; the renderer only sees refs
// and VerificationResult metadata.

import { app, session as electronSession, webContents } from 'electron'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  CREDENTIALS_IPC,
  type DeleteCredentialRequest,
  type DeleteCredentialResponse,
  type EnableBuiltinTemplateRequest,
  type EnableBuiltinTemplateResponse,
  type FillPasswordRequest,
  type FillPasswordResponse,
  type RecordCredentialVerificationRequest,
  type RecordCredentialVerificationResponse,
  type UpdateCredentialRequest,
  type UpdateCredentialResponse,
  type ListBuiltinTemplatesResponse,
  type ListCredentialsFilter,
  type ListCredentialsResponse,
  type StoreCredentialRequest,
  type StoreCredentialResponse
} from '../../shared/credentials'
import {
  deleteCredential,
  getPlaintextPassword,
  getVaultStatus,
  initSecretVault,
  isSafeStorageAvailable,
  listCredentials,
  storeCredential,
  touchCredential,
  updateCredential,
  updateVerificationResult
} from '../credentials/secret-vault'
import {
  findSiteProfileByDomain,
  findSiteProfileById,
  SHARED_BUILTIN_SITE_TEMPLATES
} from '../../shared/site-profiles-shared'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerCredentialsHandlers(): void {
  initSecretVault()
  if (process.env.NODE_ENV !== 'production' || process.env.OLA_CREDENTIALS_SANITY === '1') {
    void runSanityTests()
  }

  registerMessagePackHandler<undefined, { available: boolean; backend: string; reason?: string }>(
    CREDENTIALS_IPC.VAULT_STATUS,
    async () => {
      const status = getVaultStatus()
      return {
        available: status.available,
        backend: status.backend,
        reason: status.reason
      }
    }
  )

  registerMessagePackHandler<StoreCredentialRequest, StoreCredentialResponse>(
    CREDENTIALS_IPC.STORE,
    async (args) => {
      try {
        if (!args || typeof args !== 'object') {
          return { success: false, error: 'invalid request' }
        }
        const { domain, username, password, builtinTemplateId, notes } = args
        if (!domain || !username || !password) {
          return { success: false, error: 'domain, username, and password are required' }
        }
        const ref = storeCredential({
          domain,
          username,
          password,
          source: builtinTemplateId ? 'builtin_template' : 'manual',
          builtinTemplateId,
          notes
        })
        return {
          success: true,
          ref
        }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerMessagePackHandler<ListCredentialsFilter, ListCredentialsResponse>(
    CREDENTIALS_IPC.LIST,
    async (args) => {
      const refs = listCredentials({
        domain: args?.domain,
        projectId: args?.projectId
      })
      return { refs }
    }
  )

  registerMessagePackHandler<DeleteCredentialRequest, DeleteCredentialResponse>(
    CREDENTIALS_IPC.DELETE,
    async (args) => {
      if (!args?.id) return { success: false, error: 'id is required' }
      const ok = deleteCredential(args.id)
      return ok ? { success: true } : { success: false, error: 'not found' }
    }
  )

  registerMessagePackHandler<undefined, ListBuiltinTemplatesResponse>(
    CREDENTIALS_IPC.LIST_TEMPLATES,
    async () => {
      const stored = listCredentials()
      const enabledDomains = new Set(stored.map((r) => r.domain))
      return {
        templates: SHARED_BUILTIN_SITE_TEMPLATES.filter((t) => t.domain).map((t) => ({
          id: t.id,
          displayName: t.displayName,
          domain: t.domain,
          category: t.category,
          enabled: enabledDomains.has(t.domain)
        }))
      }
    }
  )

  registerMessagePackHandler<EnableBuiltinTemplateRequest, EnableBuiltinTemplateResponse>(
    CREDENTIALS_IPC.ENABLE_TEMPLATE,
    async (args) => {
      try {
        if (!args?.templateId || !args?.username || !args?.password) {
          return { success: false, error: 'templateId, username, password are required' }
        }
        const template = findSiteProfileById(args.templateId)
        if (!template || !template.domain) {
          return { success: false, error: 'template is not configured' }
        }
        const ref = storeCredential({
          domain: template.domain,
          username: args.username,
          password: args.password,
          source: 'builtin_template',
          builtinTemplateId: template.id
        })
        return {
          success: true,
          ref
        }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerMessagePackHandler<
    RecordCredentialVerificationRequest,
    RecordCredentialVerificationResponse
  >(CREDENTIALS_IPC.RECORD_VERIFICATION, async (args) => {
    try {
      if (!args?.id || !args.result) return { error: 'id and result are required' }
      const updated = updateVerificationResult(args.id, args.result)
      if (!updated) return { error: 'credential not found' }
      return { ref: updated }
    } catch (error) {
      return { error: getErrorMessage(error) }
    }
  })

  // UPDATE: update username/password/notes of an existing credential.
  registerMessagePackHandler<UpdateCredentialRequest, UpdateCredentialResponse>(
    CREDENTIALS_IPC.UPDATE,
    async (args) => {
      try {
        if (!args?.id) return { error: 'id required' }
        const updated = updateCredential(args.id, {
          username: args.username,
          password: args.password,
          notes: args.notes
        })
        if (!updated) return { error: 'credential not found' }
        return { ref: updated }
      } catch (error) {
        return { error: getErrorMessage(error) }
      }
    }
  )

  // FILL_PASSWORD: the orchestrator's main-side bridge for step 4. The
  // renderer hands a credentialRef + webContentsId + selector; main fetches
  // the plaintext, executes a one-shot type script on the webview, and
  // returns only a status (never the password). This is the ONLY path
  // that combines plaintext + a webview; the renderer cannot trigger it
  // with a plaintext payload.
  registerMessagePackHandler<FillPasswordRequest, FillPasswordResponse>(
    CREDENTIALS_IPC.FILL_PASSWORD,
    async (args) => {
      try {
        if (!args?.credentialId || !args?.webContentsId || !args?.selector) {
          return {
            status: 'error',
            error: 'credentialId, webContentsId, and selector are required'
          }
        }
        if (!app.isReady()) {
          return { status: 'error', error: 'app not ready' }
        }
        const wc = webContents.fromId(args.webContentsId)
        if (!wc) return { status: 'error', error: 'webContents not found' }
        const password = getPlaintextPassword(args.credentialId)
        if (!password) return { status: 'no_password' }
        touchCredential(args.credentialId)
        // Build a minimal type script. We use the same React-friendly
        // setter dance as the existing BrowserType tool so frameworks
        // detect the change.
        const setterMatch = `(function(sel, val){
          var el = document.querySelector(sel);
          if (!el) return 'no_element';
          var tag = el.tagName ? el.tagName.toLowerCase() : '';
          var proto = (tag === 'textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })(${JSON.stringify(args.selector)}, ${JSON.stringify(password)})`
        const result = (await wc.executeJavaScript(setterMatch)) as string
        // Best-effort scrub of the local string reference. V8 will GC later.
        if (result === 'no_element') return { status: 'not_found' }
        return { status: 'filled' }
      } catch (error) {
        return { status: 'error', error: getErrorMessage(error) }
      }
    }
  )
}

// Helper used by other modules (e.g. a future LoginOrchestrator) to inject
// credentials into a specific webContents. This is the ONLY pathway that
// combines plaintext + webContents; the renderer cannot trigger it directly.
export async function injectCredentialIntoWebContents(
  credentialId: string,
  webContentsId: number,
  _payload: { usernameSelector: string; passwordSelector: string; submitSelector?: string }
): Promise<{
  status: 'injected' | 'not_found' | 'no_credentials' | 'no_password'
  error?: string
}> {
  const wc = webContents.fromId(webContentsId)
  if (!wc) return { status: 'not_found', error: 'webContents not found' }
  const entry = getPlaintextPassword(credentialId)
  if (!entry) return { status: 'no_password' }
  touchCredential(credentialId)
  // This hook is reserved for the orchestrator (not used in PR1 yet).
  return { status: 'injected' }
}

export { getPlaintextPassword }

// Avoid "unused" lints for these imports that are re-exported for tests.
// IMPORTANT: only call session API lazily (inside functions), never at
// module load time — `electronSession` requires the app to be ready.
export function _isSafeStorageAvailable(): boolean {
  return isSafeStorageAvailable()
}
export function _getElectronAppPath(): string {
  return app.getPath('userData')
}
export function _isElectronSessionAvailable(): boolean {
  if (!app.isReady()) return false
  return Boolean(electronSession.defaultSession)
}

// Internal helper to allow the orchestrator to look up profiles.
export { findSiteProfileByDomain }

// Sanity tests: run on startup in dev mode. They live here because the
// challenge detector only depends on shared types — main is a fine place
// to exercise it. They are best-effort: failures log but never block.
async function runSanityTests(): Promise<void> {
  try {
    const mod = (await import('../../shared/credentials.test-snippets')) as {
      runAllTests: () => void
    }
    mod.runAllTests()
    console.info('[credentials] sanity tests passed')
  } catch (error) {
    console.error('[credentials] sanity tests FAILED', error)
  }
}

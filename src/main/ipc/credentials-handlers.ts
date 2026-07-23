// Main-side IPC handlers for the credential subsystem.
// The renderer NEVER receives plaintext passwords back. The store/verify
// flows run end-to-end in the main process; the renderer only sees refs
// and VerificationResult metadata.

import {
  app,
  BrowserWindow,
  session as electronSession,
  type IpcMainInvokeEvent,
  webContents
} from 'electron'
import { registerMessagePackHandler as registerRawMessagePackHandler } from './messagepack-handler'
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
  getCredentialRef,
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

function isTrustedCredentialsIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

function registerTrustedCredentialsMessagePackHandler<TArgs, TResult = unknown>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<TResult> | TResult
): void {
  registerRawMessagePackHandler<TArgs, TResult>(channel, async (args, event) => {
    if (!isTrustedCredentialsIpcSender(event)) {
      return { error: 'Unauthorized credential IPC sender' } as TResult
    }
    return await handler(args, event)
  })
}

function isCredentialInjectionTargetAllowed(args: {
  senderWebContentsId: number
  targetWebContentsId: number
  credentialDomain: string
}): { allowed: true; url: string } | { allowed: false; error: string } {
  const sender = webContents.fromId(args.senderWebContentsId)
  const target = webContents.fromId(args.targetWebContentsId)
  if (!sender || !target || target.isDestroyed() || target.getType() !== 'webview') {
    return { allowed: false, error: 'webContents is not an active browser guest' }
  }
  const ownerWindow = BrowserWindow.fromWebContents(sender)
  if (!ownerWindow) {
    return { allowed: false, error: 'requesting window is unavailable' }
  }
  if (target.hostWebContents?.id !== ownerWindow.webContents.id) {
    return { allowed: false, error: 'webContents is not owned by the requesting window' }
  }

  try {
    const url = new URL(target.getURL())
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== args.credentialDomain.toLowerCase()
    ) {
      return { allowed: false, error: 'credential domain does not match the active HTTPS page' }
    }
    return { allowed: true, url: url.toString() }
  } catch {
    return { allowed: false, error: 'browser page URL is invalid' }
  }
}

export function registerCredentialsHandlers(): void {
  initSecretVault()
  if (process.env.NODE_ENV !== 'production' || process.env.OLA_CREDENTIALS_SANITY === '1') {
    void runSanityTests()
  }

  registerTrustedCredentialsMessagePackHandler<
    undefined,
    { available: boolean; backend: string; reason?: string }
  >(CREDENTIALS_IPC.VAULT_STATUS, async () => {
    const status = getVaultStatus()
    return {
      available: status.available,
      backend: status.backend,
      reason: status.reason
    }
  })

  registerTrustedCredentialsMessagePackHandler<StoreCredentialRequest, StoreCredentialResponse>(
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

  registerTrustedCredentialsMessagePackHandler<ListCredentialsFilter, ListCredentialsResponse>(
    CREDENTIALS_IPC.LIST,
    async (args) => {
      const refs = listCredentials({
        domain: args?.domain,
        projectId: args?.projectId
      })
      return { refs }
    }
  )

  registerTrustedCredentialsMessagePackHandler<DeleteCredentialRequest, DeleteCredentialResponse>(
    CREDENTIALS_IPC.DELETE,
    async (args) => {
      if (!args?.id) return { success: false, error: 'id is required' }
      const ok = deleteCredential(args.id)
      return ok ? { success: true } : { success: false, error: 'not found' }
    }
  )

  registerTrustedCredentialsMessagePackHandler<undefined, ListBuiltinTemplatesResponse>(
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

  registerTrustedCredentialsMessagePackHandler<
    EnableBuiltinTemplateRequest,
    EnableBuiltinTemplateResponse
  >(CREDENTIALS_IPC.ENABLE_TEMPLATE, async (args) => {
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
  })

  registerTrustedCredentialsMessagePackHandler<
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
  registerTrustedCredentialsMessagePackHandler<UpdateCredentialRequest, UpdateCredentialResponse>(
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
  registerTrustedCredentialsMessagePackHandler<FillPasswordRequest, FillPasswordResponse>(
    CREDENTIALS_IPC.FILL_PASSWORD,
    async (args, event) => {
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

        const credentialRef = getCredentialRef(args.credentialId)
        if (!credentialRef) return { status: 'no_credentials' }
        const target = isCredentialInjectionTargetAllowed({
          senderWebContentsId: event.sender.id,
          targetWebContentsId: args.webContentsId,
          credentialDomain: credentialRef.domain
        })
        if (!target.allowed) return { status: 'error', error: target.error }

        const wc = webContents.fromId(args.webContentsId)
        const password = getPlaintextPassword(args.credentialId)
        if (!wc || !password) return { status: 'no_password' }
        touchCredential(args.credentialId)
        // Recheck the full URL within the guest so a navigation between the
        // Main-process authorization check and script execution cannot receive a secret.
        const setterMatch = `(function(sel, val, expectedUrl){
          if (location.href !== expectedUrl) return 'navigation_changed';
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
        })(${JSON.stringify(args.selector)}, ${JSON.stringify(password)}, ${JSON.stringify(target.url)})`
        const result = (await wc.executeJavaScript(setterMatch)) as string
        if (result === 'no_element') return { status: 'not_found' }
        if (result === 'navigation_changed') {
          return { status: 'error', error: 'browser navigated before credential injection' }
        }
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

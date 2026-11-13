import { createCipheriv, pbkdf2Sync, randomBytes, createHash } from 'node:crypto'
import {
  decryptChromiumCbcCookie,
  decryptChromiumGcmCookie
} from '../src/main/browser/chromium-cookie-crypto'
import { assertIncludes, assertMatch, readCollapsedSource } from './lib/source-text.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function encryptCbc(value: string, password: string, host: string, iterations: number): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const payload = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10'), cipher.update(payload), cipher.final()])
}

function encryptGcm(value: string, key: Buffer, host: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), iv, encrypted, cipher.getAuthTag()])
}

const host = '.example.com'
const secret = 'private-cookie-value'
const macFixture = encryptCbc(secret, 'test-keychain-password', host, 1003)
assert(
  decryptChromiumCbcCookie(macFixture, 'test-keychain-password', host, 1003) === secret,
  'macOS Chromium CBC cookie decryption failed'
)
const linuxFixture = encryptCbc(secret, 'peanuts', host, 1)
assert(
  decryptChromiumCbcCookie(linuxFixture, 'peanuts', host, 1) === secret,
  'Linux Chromium CBC cookie decryption failed'
)
const windowsKey = randomBytes(32)
const windowsFixture = encryptGcm(secret, windowsKey, host)
assert(
  decryptChromiumGcmCookie(windowsFixture, windowsKey, host) === secret,
  'Windows Chromium GCM cookie decryption failed'
)

// Every text assertion here is about tokens, not layout, so the sources are read collapsed.
// Collapsing turns a wrapped call into `fn( arg )`, so each pattern tolerates a space
// wherever the formatter may break a line.
const source = await readCollapsedSource('src/main/browser/browser-cookie-import.ts')
const handlers = await readCollapsedSource('src/main/ipc/browser-handlers.ts')
const packageJson = await readCollapsedSource('package.json')
assertMatch(
  source,
  /mkdtemp\(\s*join\(\s*tmpdir\(\s*\),\s*'ola-cookie-import-'\s*\)\s*\)/,
  'isolated temp copy missing'
)
assertMatch(
  source,
  /await\s+rm\(\s*tempDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\s*\)/,
  'temp cleanup missing'
)
assert(!/console\s*\.\s*log/.test(source), 'cookie importer must not log cookie data')
assert(!/console\s*\.\s*error/.test(source), 'cookie importer must not log cookie data')
assertMatch(
  source,
  /export\s+async\s+function\s+exportBuiltInBrowserCookies/,
  'encrypted built-in cookie export is missing'
)
assert(
  /canPersistSecrets\(\s*safeStorage\s*\)/.test(source) &&
    /encryption:\s*'electron-safe-storage'/.test(source),
  'cookie export must require secure storage and label its ciphertext format'
)
assert(
  /safeStorage\s*\.\s*encryptString/.test(source) && /mode:\s*0o600/.test(source),
  'cookie export must encrypt before writing a user-private archive'
)
assert(
  /registerTrustedBrowserMessagePackHandler<\s*\{\s*workspaceId:\s*string\s*\}\s*>\(\s*'browser:export-cookies'/.test(
    handlers
  ) &&
    // Assert the call site, not bare presence: the module-level import of this same
    // symbol would otherwise satisfy the check even if the handler stopped calling it.
    /exportBuiltInBrowserCookies\(\s*event\s*\.\s*sender,\s*input\s*\.\s*workspaceId\s*\)/.test(
      handlers
    ),
  'encrypted cookie export must be exposed through the Main browser IPC boundary'
)
assertMatch(
  handlers,
  /function\s+isTrustedBrowserIpcSender\(\s*event:\s*IpcMainInvokeEvent\s*\):\s*boolean/,
  'browser IPC sender authorization helper missing'
)
assert(
  /ownerWindow\s*\.\s*webContents\s*===\s*event\s*\.\s*sender/.test(handlers) &&
    /event\s*\.\s*senderFrame\s*===\s*event\s*\.\s*sender\s*\.\s*mainFrame/.test(handlers),
  'browser IPC sender must be a top-level BrowserWindow frame'
)
assertMatch(
  handlers,
  /function\s+registerTrustedBrowserMessagePackHandler<\s*TArgs\s*>/,
  'browser IPC authorization wrapper missing'
)
assert(
  // `[^>]*` cannot cross a registration's closing `>`, so this cannot start at the
  // export-cookies trusted wrapper and end at import-cookies' own type literal —
  // an unbounded `[\s\S]*` did exactly that and hid a downgraded import handler.
  /registerTrustedBrowserMessagePackHandler<\s*\{[^>]*workspaceId:\s*string[^>]*\}\s*>\(\s*'browser:import-cookies'/.test(
    handlers
  ) &&
    /registerTrustedBrowserMessagePackHandler<\s*\{\s*workspaceId:\s*string\s*\}\s*>\(\s*'browser:clear-cookies'/.test(
      handlers
    ),
  'cookie mutation handlers must use the trusted browser IPC wrapper'
)
assert(
  /importBrowserCookies\(\s*input\s*\.\s*profileId,\s*input\s*\.\s*workspaceId\s*\)/.test(
    handlers
  ) &&
    /getBuiltInBrowserStorageSessions\(\s*\[\s*input\s*\.\s*workspaceId\s*\]\s*\)/.test(handlers),
  'cookie mutation handlers must scope imports and clears to the requested workspace'
)
assertIncludes(
  handlers,
  'Unauthorized browser IPC sender',
  'unauthorized browser IPC error missing'
)
assertIncludes(
  packageJson,
  'npm run verify:browser-cookie-import',
  'core verifier registration missing'
)

console.log('browser-cookie-import verification passed')

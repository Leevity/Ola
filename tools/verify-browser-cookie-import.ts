import { createCipheriv, pbkdf2Sync, randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  decryptChromiumCbcCookie,
  decryptChromiumGcmCookie
} from '../src/main/browser/chromium-cookie-crypto'

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

const source = await readFile(
  path.join(process.cwd(), 'src/main/browser/browser-cookie-import.ts'),
  'utf8'
)
const handlers = await readFile(
  path.join(process.cwd(), 'src/main/ipc/browser-handlers.ts'),
  'utf8'
)
const packageJson = await readFile(path.join(process.cwd(), 'package.json'), 'utf8')
assert(
  source.includes("mkdtemp(join(tmpdir(), 'ola-cookie-import-'))"),
  'isolated temp copy missing'
)
assert(
  source.includes('await rm(tempDir, { recursive: true, force: true })'),
  'temp cleanup missing'
)
assert(!source.includes('console.log'), 'cookie importer must not log cookie data')
assert(!source.includes('console.error'), 'cookie importer must not log cookie data')
assert(
  /function isTrustedBrowserIpcSender\(event: IpcMainInvokeEvent\): boolean/.test(handlers),
  'browser IPC sender authorization helper missing'
)
assert(
  /ownerWindow\.webContents === event\.sender/.test(handlers) &&
    /event\.senderFrame === event\.sender\.mainFrame/.test(handlers),
  'browser IPC sender must be a top-level BrowserWindow frame'
)
assert(
  /function registerTrustedBrowserMessagePackHandler<TArgs>/.test(handlers),
  'browser IPC authorization wrapper missing'
)
assert(
  /registerTrustedBrowserMessagePackHandler<[\s\S]*browser:import-cookies/.test(handlers) &&
    /registerTrustedBrowserMessagePackHandler<undefined>\('browser:clear-cookies'/.test(handlers),
  'cookie mutation handlers must use the trusted browser IPC wrapper'
)
assert(
  handlers.includes('Unauthorized browser IPC sender'),
  'unauthorized browser IPC error missing'
)
assert(
  packageJson.includes('npm run verify:browser-cookie-import'),
  'core verifier registration missing'
)

console.log('browser-cookie-import verification passed')

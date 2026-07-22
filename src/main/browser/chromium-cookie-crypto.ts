import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'

const CHROMIUM_IV = Buffer.alloc(16, 0x20)

function safeUnpad(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer
  const padding = buffer.at(-1) ?? 0
  if (padding < 1 || padding > 16 || padding > buffer.length) return buffer
  return buffer.subarray(0, buffer.length - padding)
}

function stripHostDigest(value: Buffer, host: string): Buffer {
  if (value.length <= 32) return value
  const expected = createHash('sha256').update(host).digest()
  return value.subarray(0, 32).equals(expected) ? value.subarray(32) : value
}

export function decryptChromiumCbcCookie(
  encrypted: Buffer,
  password: string,
  host: string,
  iterations: number
): string {
  const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, CHROMIUM_IV)
  decipher.setAutoPadding(false)
  const plain = safeUnpad(Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]))
  return stripHostDigest(plain, host).toString('utf8')
}

export function decryptChromiumGcmCookie(encrypted: Buffer, key: Buffer, host: string): string {
  const payload = encrypted.subarray(3)
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(-16)
  const ciphertext = payload.subarray(12, -16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return stripHostDigest(plain, host).toString('utf8')
}

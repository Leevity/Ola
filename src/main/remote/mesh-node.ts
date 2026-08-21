import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { createHash, generateKeyPairSync, randomUUID } from 'crypto'
import { join } from 'path'
import type { MeshCapability, MeshNodePlatform } from '../../shared/mesh-protocol'

type StoredMeshIdentity = {
  nodeKeyId: string
  privateKey: string
  publicKey: string
}

export type DesktopMeshIdentity = {
  nodeKeyId: string
  privateKey: string
  publicKey: string
}

const IDENTITY_FILE = 'mesh-node-identity.bin'

export function desktopMeshPlatform(): MeshNodePlatform {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

export function desktopMeshCapabilities(): MeshCapability[] {
  return [
    { id: 'mesh.event.receive', risk: 'low', version: '1' },
    { id: 'task.execute', risk: 'high', version: '1' },
    { id: 'terminal.execute', risk: 'high', version: '1' },
    { id: 'file.read', risk: 'medium', version: '1' },
    { id: 'file.write', risk: 'high', version: '1' }
  ]
}

function identityPath(): string {
  return join(app.getPath('userData'), IDENTITY_FILE)
}

function encodeRawPublicKey(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const der = key.export({ format: 'der', type: 'spki' })
  return der.subarray(-32).toString('base64url')
}

function validateIdentity(value: StoredMeshIdentity): DesktopMeshIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid Mesh node identity')
  if (!value.nodeKeyId || !value.privateKey || !value.publicKey) {
    throw new Error('Incomplete Mesh node identity')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.publicKey)) {
    throw new Error('Invalid Mesh node public key')
  }
  return value
}

export async function loadDesktopMeshIdentity(): Promise<DesktopMeshIdentity> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is required for Mesh node identity')
  }
  try {
    const encrypted = await readFile(identityPath())
    return validateIdentity(JSON.parse(safeStorage.decryptString(encrypted)) as StoredMeshIdentity)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const identity: StoredMeshIdentity = {
    nodeKeyId: `key-${randomUUID()}`,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: encodeRawPublicKey(publicKey)
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(identity))
  const target = identityPath()
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, encrypted, { mode: 0o600 })
  await rename(temporary, target)
  return identity
}

export function meshIdentityFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16)
}

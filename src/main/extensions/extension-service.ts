import { type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { ExtensionInstance, ExtensionManifest } from '../../shared/extension-types'
import { readExtensionManifest } from './extension-manifest'
import {
  normalizeExtensionId,
  resolveExtensionAssetPath,
  resolveExtensionPath
} from './extension-paths'
import { ExtensionStateStore, type ExtensionState } from './extension-state-store'

export interface ExtensionSecretStore {
  get(extensionId: string, key: string): Promise<string>
  set(extensionId: string, key: string, value: string): Promise<void>
  delete(extensionId: string, key: string): Promise<void>
}

export type RuntimeExtension = {
  id: string
  enabled: boolean
  manifest: ExtensionManifest
  config: Record<string, string>
}

function secretKeys(manifest: ExtensionManifest): Set<string> {
  return new Set(
    (manifest.configSchema ?? [])
      .filter((field) => field.type === 'secret')
      .map((field) => field.key)
  )
}

function defaults(manifest: ExtensionManifest): Record<string, string> {
  return Object.fromEntries(
    (manifest.configSchema ?? []).map((field) => [field.key, field.defaultValue ?? ''])
  )
}

function publicConfig(
  manifest: ExtensionManifest,
  config: Record<string, string>
): Record<string, string> {
  const secrets = secretKeys(manifest)
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, secrets.has(key) ? '' : value])
  )
}

/** Combines manifest defaults, extension state and a host-owned secret store. */
export class ExtensionService {
  constructor(
    private readonly extensionsDirectory: string,
    private readonly stateStore: ExtensionStateStore,
    private readonly secrets: ExtensionSecretStore
  ) {}

  async list(): Promise<ExtensionInstance[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.extensionsDirectory, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const result: ExtensionInstance[] = []
    const retained: string[] = []
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const manifest = await readExtensionManifest(this.extensionsDirectory, entry.name)
        const state = await this.stateStore.getOrCreate(manifest.id)
        const config = await this.runtimeConfig(manifest, state)
        retained.push(manifest.id)
        result.push({
          id: manifest.id,
          enabled: state.enabled,
          installedAt: state.installedAt,
          updatedAt: state.updatedAt,
          config: publicConfig(manifest, config),
          manifest
        })
      } catch {
        // A corrupt third-party extension must not stop healthy extensions from loading.
      }
    }
    await this.stateStore.retain(retained)
    return result
  }

  async getRuntime(extensionId: unknown): Promise<RuntimeExtension> {
    const id = normalizeExtensionId(extensionId)
    const manifest = await this.getManifest(id)
    const state = await this.stateStore.getOrCreate(id)
    return {
      id,
      enabled: state.enabled,
      manifest,
      config: await this.runtimeConfig(manifest, state)
    }
  }

  async getManifest(extensionId: unknown): Promise<ExtensionManifest> {
    const id = normalizeExtensionId(extensionId)
    return await readExtensionManifest(this.extensionsDirectory, id)
  }

  async update(
    extensionId: unknown,
    patch: { enabled?: boolean; config?: Record<string, string> }
  ): Promise<ExtensionInstance> {
    const id = normalizeExtensionId(extensionId)
    const manifest = await readExtensionManifest(this.extensionsDirectory, id)
    const current = await this.stateStore.getOrCreate(id)
    const secretFields = secretKeys(manifest)
    const runtime = await this.runtimeConfig(manifest, current)
    const nextConfig = { ...runtime }
    for (const [key, value] of Object.entries(patch.config ?? {})) {
      if (secretFields.has(key) && value === '') continue
      nextConfig[key] = value
    }
    for (const key of secretFields) {
      if (Object.hasOwn(patch.config ?? {}, key) && patch.config![key] !== '')
        await this.secrets.set(id, key, nextConfig[key] ?? '')
    }
    const persistedConfig = Object.fromEntries(
      Object.entries(nextConfig).filter(([key]) => !secretFields.has(key))
    )
    const state = await this.stateStore.update(id, {
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      config: persistedConfig
    })
    const config = await this.runtimeConfig(manifest, state)
    return {
      id,
      enabled: state.enabled,
      installedAt: state.installedAt,
      updatedAt: state.updatedAt,
      config: publicConfig(manifest, config),
      manifest
    }
  }

  private async runtimeConfig(
    manifest: ExtensionManifest,
    state: ExtensionState
  ): Promise<Record<string, string>> {
    const result = { ...defaults(manifest), ...state.config }
    for (const key of secretKeys(manifest)) result[key] = await this.secrets.get(manifest.id, key)
    return result
  }

  getPath(extensionId: unknown): string {
    return resolveExtensionPath(this.extensionsDirectory, extensionId)
  }

  getAssetPath(extensionId: unknown, assetPath: unknown): string {
    return resolveExtensionAssetPath(this.extensionsDirectory, extensionId, assetPath)
  }
}

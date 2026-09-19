import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { normalizeExtensionId } from './extension-paths'

export type ExtensionState = {
  enabled: boolean
  installedAt: number
  updatedAt: number
  config: Record<string, string>
}

type StateRoot = Record<string, ExtensionState>

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      typeof item === 'string' ? [[key, item]] : []
    )
  )
}

function readState(value: unknown, now: number): ExtensionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  return {
    enabled: item.enabled === true,
    installedAt: typeof item.installedAt === 'number' ? item.installedAt : now,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
    config: readStringMap(item.config)
  }
}

function parseRoot(value: string, now: number): StateRoot {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, state]) => {
        try {
          const normalizedId = normalizeExtensionId(id)
          const normalizedState = readState(state, now)
          return normalizedState ? [[normalizedId, normalizedState]] : []
        } catch {
          return []
        }
      })
    )
  } catch {
    return {}
  }
}

/** Serialized owner for the legacy ~/.ola/extensions.json state file. */
export class ExtensionStateStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  async read(): Promise<StateRoot> {
    try {
      return parseRoot(await readFile(this.path, 'utf8'), this.now())
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
      throw error
    }
  }

  async get(extensionId: unknown): Promise<ExtensionState | null> {
    const state = (await this.read())[normalizeExtensionId(extensionId)]
    return state ? { ...state, config: { ...state.config } } : null
  }

  async getOrCreate(extensionId: unknown, enabled = false): Promise<ExtensionState> {
    const id = normalizeExtensionId(extensionId)
    let result: ExtensionState | undefined
    await this.mutate((root) => {
      const now = this.now()
      result = root[id] ?? {
        enabled,
        installedAt: now,
        updatedAt: now,
        config: {}
      }
      root[id] = result
    })
    return { ...result!, config: { ...result!.config } }
  }

  async update(
    extensionId: unknown,
    patch: { enabled?: boolean; config?: Record<string, string> }
  ): Promise<ExtensionState> {
    const id = normalizeExtensionId(extensionId)
    let result: ExtensionState | undefined
    await this.mutate((root) => {
      const now = this.now()
      const current = root[id] ?? { enabled: false, installedAt: now, updatedAt: now, config: {} }
      result = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
        installedAt: current.installedAt,
        updatedAt: now,
        config: patch.config ? { ...patch.config } : { ...current.config }
      }
      root[id] = result
    })
    return { ...result!, config: { ...result!.config } }
  }

  delete(extensionId: unknown): Promise<void> {
    const id = normalizeExtensionId(extensionId)
    return this.mutate((root) => {
      delete root[id]
    })
  }

  retain(extensionIds: Iterable<string>): Promise<void> {
    const keep = new Set([...extensionIds].map(normalizeExtensionId))
    return this.mutate((root) => {
      for (const id of Object.keys(root)) {
        if (!keep.has(id)) delete root[id]
      }
    })
  }

  private mutate(change: (root: StateRoot) => void): Promise<void> {
    const result = this.tail.then(async () => {
      const root = await this.read()
      change(root)
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = join(dirname(this.path), `.${randomUUID()}.extensions.json`)
      await writeFile(temporary, JSON.stringify(root, null, 2), 'utf8')
      await rename(temporary, this.path)
    })
    this.tail = result.catch(() => undefined)
    return result
  }
}

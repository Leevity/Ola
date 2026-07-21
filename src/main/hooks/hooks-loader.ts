import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  HOOK_EVENTS,
  HOOKS_SCHEMA_VERSION,
  type HookCommandConfig,
  type HooksConfig,
  type HookSource,
  type LoadedHook
} from '../../shared/hooks/types'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_HOOKS = 100

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseHook(value: unknown, index: number): HookCommandConfig {
  if (!isRecord(value)) throw new Error(`Hook ${index + 1} must be an object`)
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value.id)) {
    throw new Error(`Hook ${index + 1} has an invalid id`)
  }
  if (!HOOK_EVENTS.includes(value.event as (typeof HOOK_EVENTS)[number])) {
    throw new Error(`Hook ${value.id} has an unsupported event`)
  }
  if (typeof value.command !== 'string' || !value.command.trim()) {
    throw new Error(`Hook ${value.id} has an invalid command`)
  }
  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new Error(`Hook ${value.id} args must be an array`)
  }
  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) {
    throw new Error(`Hook ${value.id} artifacts must be an array`)
  }
  const args = (value.args ?? []).map((arg) => {
    if (typeof arg !== 'string') throw new Error(`Hook ${value.id} args must be strings`)
    return arg
  })
  const artifacts = (value.artifacts ?? []).map((artifact) => {
    if (typeof artifact !== 'string' || !artifact.trim()) {
      throw new Error(`Hook ${value.id} artifacts must be non-empty strings`)
    }
    return artifact
  })
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeoutMs)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Hook ${value.id} timeout must be between 100 and ${MAX_TIMEOUT_MS}ms`)
  }
  return {
    id: value.id,
    event: value.event as HookCommandConfig['event'],
    command: value.command,
    args,
    artifacts,
    timeoutMs,
    enabled: value.enabled !== false
  }
}

export function parseHooksConfig(value: unknown): HooksConfig {
  if (!isRecord(value) || value.version !== HOOKS_SCHEMA_VERSION || !Array.isArray(value.hooks)) {
    throw new Error(`Hooks config must use schema version ${HOOKS_SCHEMA_VERSION}`)
  }
  if (value.hooks.length > MAX_HOOKS) throw new Error(`Hooks config exceeds ${MAX_HOOKS} hooks`)
  const hooks = value.hooks.map(parseHook)
  if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
    throw new Error('Hook ids must be unique within a config')
  }
  return { version: HOOKS_SCHEMA_VERSION, hooks }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

async function resolveExecutable(command: string, configPath: string): Promise<string> {
  const candidate = isAbsolute(command) ? command : resolve(dirname(configPath), command)
  const canonical = await realpath(candidate)
  const allowedRoot = await realpath(dirname(configPath))
  if (!isWithin(canonical, allowedRoot)) {
    throw new Error(`Hook executable escapes its config directory: ${command}`)
  }
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error(`Hook executable is not a file: ${command}`)
  await access(canonical, constants.X_OK)
  return canonical
}

export async function loadHooksConfig(
  configPath: string,
  source: HookSource,
  trustedKeys: ReadonlySet<string> = new Set()
): Promise<LoadedHook[]> {
  const canonicalConfigPath = await realpath(configPath)
  const rawConfig = await readFile(canonicalConfigPath)
  const config = parseHooksConfig(JSON.parse(rawConfig.toString('utf8')))
  const configHash = hash(rawConfig)
  return Promise.all(
    config.hooks.map(async (hook) => {
      const executablePath = await resolveExecutable(hook.command, canonicalConfigPath)
      const executableHash = hash(await readFile(executablePath))
      const artifactEntries = await Promise.all(
        (hook.artifacts ?? []).map(async (artifact) => {
          const artifactPath = await resolveExecutable(artifact, canonicalConfigPath)
          return [artifactPath, hash(await readFile(artifactPath))] as const
        })
      )
      const artifactHashes = Object.fromEntries(artifactEntries)
      const trustKey = hash(
        JSON.stringify({
          source,
          configPath: canonicalConfigPath,
          configHash,
          executablePath,
          executableHash,
          artifactHashes
        })
      )
      return {
        ...hook,
        args: hook.args ?? [],
        artifacts: hook.artifacts ?? [],
        timeoutMs: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        enabled: hook.enabled !== false,
        source,
        configPath: canonicalConfigPath,
        configHash,
        executablePath,
        executableHash,
        artifactHashes,
        trustKey,
        trustState: trustedKeys.has(trustKey) ? 'trusted' : 'pending'
      }
    })
  )
}

export function hooksConfigPaths(homePath: string, projectPath?: string): string[] {
  const paths = [join(homePath, '.ola', 'hooks.json')]
  if (projectPath) paths.push(join(projectPath, '.ola', 'hooks.json'))
  return paths
}

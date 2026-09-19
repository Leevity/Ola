import { randomBytes } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeManifest,
  TeamRuntimeMemberRecord,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../../shared/team-runtime-types'

const lockRetryDelaysMs = [25, 50, 100, 200, 400]
const idAlphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Compatibility owner for ~/.ola/teams. The lockfile protocol matches the
 * Native Worker, allowing a staged migration to share existing team state.
 */
export class TeamRuntimeStore {
  constructor(private readonly teamsDirectory = join(olaDataRoot(), 'teams')) {}

  async create(input: CreateTeamRuntimeArgs): Promise<TeamRuntimeCreateResult> {
    const teamName = sanitizeTeamName(input.teamName)
    if (!teamName) throw new Error('Invalid team name')
    const runtimePath = this.teamPath(teamName)
    const manifestPath = join(runtimePath, 'team.json')
    await this.withLock(manifestPath, async () => {
      if (await exists(manifestPath)) throw new Error(`Team "${teamName}" already exists`)
      await mkdir(runtimePath, { recursive: true })
      const now = Date.now()
      const leadAgentId = `team-lead@${teamName}-${createId(6)}`
      const lead: TeamRuntimeMemberRecord = {
        agentId: leadAgentId,
        name: 'lead',
        role: 'lead',
        backendType: 'in-process',
        status: 'idle',
        currentTaskId: null,
        isActive: true,
        startedAt: now,
        completedAt: null,
        ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {})
      }
      const manifest: TeamRuntimeManifest = {
        version: 1,
        name: teamName,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
        runtimePath,
        leadAgentId,
        ...(input.sessionId?.trim() ? { leadSessionId: input.sessionId.trim() } : {}),
        defaultBackend: 'in-process',
        permissionMode: 'default',
        teamAllowedPaths: input.workingFolder?.trim() ? [input.workingFolder.trim()] : [],
        members: [lead],
        tasks: []
      }
      await writeJson(manifestPath, manifest)
      await writeFile(join(runtimePath, 'messages.jsonl'), '', 'utf8')
    })
    const manifest = await this.readManifest(teamName)
    if (!manifest) throw new Error(`Team "${teamName}" does not exist`)
    return {
      teamName,
      runtimePath,
      leadAgentId: manifest.leadAgentId,
      createdAt: manifest.createdAt,
      defaultBackend: 'in-process',
      permissionMode: manifest.permissionMode,
      teamAllowedPaths: manifest.teamAllowedPaths
    }
  }

  async delete(input: DeleteTeamRuntimeArgs): Promise<{ success: true }> {
    await rm(this.teamPath(input.teamName), { recursive: true, force: true })
    return { success: true }
  }

  async appendMessage(input: AppendTeamRuntimeMessageArgs): Promise<{ success: true }> {
    if (!(await this.readManifest(input.teamName))) {
      throw new Error(`Team "${input.teamName}" does not exist`)
    }
    const filePath = this.messagesPath(input.teamName)
    await this.withLock(filePath, async () => {
      await this.migrateLegacyMessages(input.teamName)
      const message = input.message
      await writeFile(filePath, `${JSON.stringify(message)}\n`, { encoding: 'utf8', flag: 'a' })
    })
    await this.touchManifest(input.teamName)
    return { success: true }
  }

  async snapshot(input: GetTeamRuntimeSnapshotArgs): Promise<TeamRuntimeSnapshot | null> {
    const team = await this.readManifest(input.teamName)
    if (!team) return null
    return { team, recentMessages: await this.readRecentMessages(input.teamName, input.limit) }
  }

  async updateMember(input: UpdateTeamRuntimeMemberArgs): Promise<{ success: true }> {
    await this.updateManifest(input.teamName, (manifest) => {
      let member = manifest.members.find((item) => item.agentId === input.memberId)
      if (!member) {
        member = {
          agentId: input.memberId,
          name: input.memberId,
          role: 'worker',
          backendType: 'in-process',
          status: 'idle',
          currentTaskId: null,
          isActive: true,
          startedAt: Date.now(),
          completedAt: null
        }
        manifest.members.push(member)
      }
      Object.assign(member, input.patch)
    })
    return { success: true }
  }

  async updateManifestPatch(input: UpdateTeamRuntimeManifestArgs): Promise<{ success: true }> {
    await this.updateManifest(input.teamName, (manifest) => Object.assign(manifest, input.patch))
    return { success: true }
  }

  async consumeMessages(
    input: ConsumeTeamRuntimeMessagesArgs
  ): Promise<TeamRuntimeMessageRecord[]> {
    if (!(await this.readManifest(input.teamName))) return []
    const afterTimestamp = Math.max(0, Math.trunc(input.afterTimestamp ?? 0))
    const recipient = input.recipient?.trim()
    const includeBroadcast = input.includeBroadcast !== false
    const messages = (await this.readMessages(input.teamName)).filter((message) => {
      if (message.timestamp <= afterTimestamp) return false
      return !recipient || message.to === recipient || (includeBroadcast && message.to === 'all')
    })
    return messages.slice(-clampLimit(input.limit, 20))
  }

  private async touchManifest(teamName: string): Promise<void> {
    await this.updateManifest(teamName, () => undefined)
  }

  private async updateManifest(
    teamName: string,
    mutate: (manifest: TeamRuntimeManifest) => void
  ): Promise<void> {
    const manifestPath = this.manifestPath(teamName)
    await this.withLock(manifestPath, async () => {
      const manifest = await this.readManifest(teamName)
      if (!manifest) throw new Error(`Team "${teamName}" does not exist`)
      mutate(manifest)
      manifest.updatedAt = Date.now()
      await writeJson(manifestPath, manifest)
    })
  }

  private async readRecentMessages(
    teamName: string,
    limit?: number
  ): Promise<TeamRuntimeMessageRecord[]> {
    return (await this.readMessages(teamName)).slice(-clampLimit(limit, 10))
  }

  private async readMessages(teamName: string): Promise<TeamRuntimeMessageRecord[]> {
    const jsonlPath = this.messagesPath(teamName)
    if (await exists(jsonlPath)) return await readJsonl(jsonlPath)
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.teamPath(teamName), 'messages.json'), 'utf8')
      )
      return Array.isArray(value) ? value.filter(isMessage) : []
    } catch {
      return []
    }
  }

  private async migrateLegacyMessages(teamName: string): Promise<void> {
    const jsonlPath = this.messagesPath(teamName)
    if (await exists(jsonlPath)) return
    const legacyPath = join(this.teamPath(teamName), 'messages.json')
    const messages = await this.readMessages(teamName)
    await writeFile(
      jsonlPath,
      messages.map((message) => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''),
      'utf8'
    )
    if (await exists(legacyPath)) await unlink(legacyPath)
  }

  private async readManifest(teamName: string): Promise<TeamRuntimeManifest | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.manifestPath(teamName), 'utf8'))
      return isManifest(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private teamPath(rawName: string): string {
    const safeName = sanitizeTeamName(rawName)
    if (!safeName) throw new Error('Invalid team name')
    const root = resolve(this.teamsDirectory)
    const target = resolve(root, safeName)
    const relativePath = relative(root, target)
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      relativePath.startsWith('..\\') ||
      isAbsolute(relativePath)
    )
      throw new Error('Path escapes team directory')
    return target
  }

  private manifestPath(teamName: string): string {
    return join(this.teamPath(teamName), 'team.json')
  }

  private messagesPath(teamName: string): string {
    return join(this.teamPath(teamName), 'messages.jsonl')
  }

  private async withLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(filePath), { recursive: true })
    const lockPath = `${filePath}.lock`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt <= lockRetryDelaysMs.length; attempt++) {
      try {
        handle = await open(lockPath, 'wx')
        break
      } catch (error) {
        if (attempt === lockRetryDelaysMs.length || !isExistsError(error)) throw error
        await delay(lockRetryDelaysMs[attempt])
      }
    }
    if (!handle) throw new Error(`Timed out acquiring lock for ${lockPath}`)
    try {
      return await action()
    } finally {
      await handle.close()
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

function sanitizeTeamName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function createId(length: number): string {
  return [...randomBytes(length)].map((value) => idAlphabet[value % idAlphabet.length]).join('')
}

function clampLimit(value: number | undefined, fallback: number): number {
  const next = !value || value <= 0 ? fallback : value
  return Math.max(1, Math.min(50, Math.floor(next)))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${createId(12)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function readJsonl(path: string): Promise<TeamRuntimeMessageRecord[]> {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value: unknown = JSON.parse(line)
        return isMessage(value) ? [value] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function isMessage(value: unknown): value is TeamRuntimeMessageRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as TeamRuntimeMessageRecord).id === 'string' &&
    typeof (value as TeamRuntimeMessageRecord).timestamp === 'number'
  )
}

function isManifest(value: unknown): value is TeamRuntimeManifest {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as TeamRuntimeManifest).version === 1 &&
    typeof (value as TeamRuntimeManifest).name === 'string' &&
    Array.isArray((value as TeamRuntimeManifest).members) &&
    Array.isArray((value as TeamRuntimeManifest).tasks)
  )
}

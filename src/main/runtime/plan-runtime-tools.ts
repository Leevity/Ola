import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat, lstat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { getPlanBySession, createPlan, updatePlan, type PlanRow } from '../db/plans-dao'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { execSshCommand, readSshRuntimeText } from '../ipc/ssh-handlers'
import { withSshWorkspace } from '../ssh/ssh-config'
import { authorizeSshWorkspace } from '../ssh/ssh-workspace-authorization'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

const MAX_TITLE = 1024
const MAX_CONTENT = 4 * 1024 * 1024

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const text = value.trim()
  return text || undefined
}

function planResource(context: { run: { workspaceId: string; sessionId: string } }): string {
  return `plan:${context.run.workspaceId}:${context.run.sessionId}`
}

function planPayload(row: PlanRow): Record<string, unknown> {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    filePath: row.file_path ?? undefined,
    content: row.content ?? undefined,
    specJson: row.spec_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id ?? undefined
  }
}

async function planFilePath(
  context: {
    run: { workingDirectory?: string; sshConnectionId?: string; workspaceId: string }
  },
  id: string,
  create: boolean
): Promise<string> {
  const root = context.run.workingDirectory?.trim()
  if (!root) throw new RuntimeError('WORKING_DIRECTORY_REQUIRED')
  if (context.run.sshConnectionId) {
    const workspaceId = await authorizeSshWorkspace(
      context.run.workspaceId,
      loadOfflineWorkspaceIds
    )
    const directory = `${root.replace(/[\\/]+$/, '')}/.plan`
    const target = `${directory}/${id}.md`
    if (create) {
      const result = await withSshWorkspace(workspaceId, () =>
        execSshCommand(
          context.run.sshConnectionId!,
          `mkdir -p -- '${directory.replace(/'/g, "'\\''")}' && if [ -e '${target.replace(/'/g, "'\\''")}' ] && [ ! -f '${target.replace(/'/g, "'\\''")}' ]; then exit 3; fi; : > '${target.replace(/'/g, "'\\''")}'`
        )
      )
      if (!result.success || result.exitCode !== 0) throw new RuntimeError('PLAN_FILE_UNAVAILABLE')
    }
    return target
  }
  const realRoot = await realpath(root).catch(() => {
    throw new RuntimeError('WORKING_DIRECTORY_UNAVAILABLE')
  })
  const rootStat = await stat(realRoot).catch(() => undefined)
  if (!rootStat?.isDirectory()) throw new RuntimeError('WORKING_DIRECTORY_UNAVAILABLE')
  const directory = resolve(realRoot, '.plan')
  if (create) await mkdir(directory, { recursive: true })
  const realDirectory = await realpath(directory).catch(() => {
    throw new RuntimeError('PLAN_FILE_UNAVAILABLE')
  })
  const outside = relative(realRoot, realDirectory)
  if (outside === '..' || outside.startsWith(`..${sep}`))
    throw new RuntimeError('PLAN_FILE_FORBIDDEN')
  const target = join(realDirectory, `${id}.md`)
  if (create) {
    const existing = await lstat(target).catch(() => undefined)
    if (!existing) {
      const handle = await open(target, 'wx', 0o600)
      await handle.close()
    } else if (!existing.isFile()) {
      throw new RuntimeError('PLAN_FILE_FORBIDDEN')
    }
  }
  return target
}

function titleFromContent(content: string): string {
  const first = content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return 'Plan'
  const title = first
    .replace(/^#+\s*/, '')
    .replace(/^plan:\s*/i, '')
    .trim()
  return title.slice(0, 80) || 'Plan'
}

export function createPlanRuntimeTools(): ToolDefinition[] {
  const enter: ToolDefinition = {
    name: 'EnterPlanMode',
    description: 'Create or reopen the workspace-scoped plan for this session.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', maxLength: MAX_TITLE } },
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = inputRecord(value)
      return { reason: optionalText(input.reason, MAX_TITLE) ?? 'Implementation plan' }
    },
    resources: async (_value, context) => [planResource(context)],
    execute: async (value, context) => {
      const existing = await getPlanBySession(context.run.sessionId, context.run.workspaceId)
      if (existing && !['rejected', 'completed'].includes(existing.status)) {
        if (!existing.file_path) throw new RuntimeError('LEGACY_PLAN_FILE_REQUIRED')
        await planFilePath(context, existing.id, true)
        return { plan: planPayload(existing), reused: true }
      }
      const now = Date.now()
      const input = value as { reason: string }
      const id = randomUUID()
      const filePath = await planFilePath(context, id, true)
      await createPlan({
        id,
        sessionId: context.run.sessionId,
        workspaceId: context.run.workspaceId,
        title: input.reason,
        status: 'drafting',
        filePath,
        createdAt: now,
        updatedAt: now
      })
      const plan = await getPlanBySession(context.run.sessionId, context.run.workspaceId)
      if (!plan) throw new RuntimeError('PLAN_NOT_CREATED')
      return { plan: planPayload(plan), reused: false }
    }
  }

  const exit: ToolDefinition = {
    name: 'ExitPlanMode',
    description: 'Finalize a written plan for workspace-scoped user review.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'write',
    validate: (value) => {
      inputRecord(value)
      return {}
    },
    resources: async (_value, context) => [planResource(context)],
    execute: async (_value, context) => {
      const plan = await getPlanBySession(context.run.sessionId, context.run.workspaceId)
      if (!plan) throw new RuntimeError('PLAN_NOT_FOUND')
      if (!plan.file_path) throw new RuntimeError('PLAN_CONTENT_REQUIRED')
      const target = await planFilePath(context, plan.id, false)
      const text = context.run.sshConnectionId
        ? await authorizeSshWorkspace(context.run.workspaceId, loadOfflineWorkspaceIds)
            .then((workspaceId) =>
              withSshWorkspace(workspaceId, () =>
                readSshRuntimeText(context.run.sshConnectionId!, target)
              )
            )
            .catch(() => {
              throw new RuntimeError('PLAN_FILE_UNAVAILABLE')
            })
        : await readFile(target)
            .then((content) => {
              if (content.byteLength > MAX_CONTENT) throw new RuntimeError('PLAN_CONTENT_TOO_LARGE')
              return content.toString('utf8')
            })
            .catch((error) => {
              if (error instanceof RuntimeError) throw error
              throw new RuntimeError('PLAN_FILE_UNAVAILABLE')
            })
      if (!text.trim()) throw new RuntimeError('PLAN_CONTENT_REQUIRED')
      const title = titleFromContent(text)
      await updatePlan(plan.id, context.run.workspaceId, {
        status: 'awaiting_review',
        title,
        content: text,
        updatedAt: Date.now()
      })
      const updated = await getPlanBySession(context.run.sessionId, context.run.workspaceId)
      if (!updated) throw new RuntimeError('PLAN_NOT_UPDATED')
      return { plan: { ...planPayload(updated), content: text }, awaitingUserReview: true }
    }
  }

  return [enter, exit]
}

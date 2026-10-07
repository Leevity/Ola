import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertScenarioToolPolicy } from '../../src/main/runtime/scenario-tool-policy'
import { DesktopRuntime } from '../../src/main/runtime/desktop-runtime'
import {
  businessWriteCanary,
  closeBusinessWriteCanary
} from '../../src/main/db/business-write-canary'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import type { RunSpec } from '../../src/shared/runtime/contracts'
import { scenarioAllowsTool } from '../../src/shared/scenario-policy'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function run(toolNames: string[], patch: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'run',
    taskId: 'task',
    requestId: 'request',
    traceId: 'trace',
    sessionId: 'session',
    workspaceId: 'local-personal',
    environmentId: 'local',
    prompt: 'review',
    unattended: false,
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    toolNames,
    ...patch
  }
}

describe('persisted scenario tool policy', () => {
  it('excludes plugin, MCP, team, browser, shell and write tools from both policies', () => {
    for (const policy of ['project-read-only', 'ssh-read-only'] as const) {
      expect(scenarioAllowsTool(policy, 'Read')).toBe(true)
      for (const name of [
        'Write',
        'Bash',
        'PluginSendMessage',
        'mcp__server__read',
        'Task',
        'BrowserNavigate'
      ]) {
        expect(scenarioAllowsTool(policy, name)).toBe(false)
      }
    }
    expect(scenarioAllowsTool('materials-no-tools', 'Read')).toBe(false)
    expect(scenarioAllowsTool('materials-no-tools', 'WebSearch')).toBe(false)
  })

  it('keeps a project review policy in the TS business database after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-scenario-policy-db-'))
    roots.push(root)
    const path = join(root, 'data.db')
    const first = new BusinessRepository({ path, mode: 'direct' })
    try {
      await first.createSession({
        id: 'session',
        title: 'Project review',
        mode: 'chat',
        createdAt: 1,
        updatedAt: 1,
        workspaceId: 'local-personal',
        workingFolder: root,
        scenarioPolicy: 'project-read-only'
      })
    } finally {
      await first.close()
    }
    const reopened = new BusinessRepository({ path, mode: 'direct' })
    try {
      await expect(reopened.sessions('local-personal')).resolves.toEqual([
        expect.objectContaining({
          id: 'session',
          scenario_policy: 'project-read-only'
        })
      ])
      await expect(reopened.sessions('other-workspace')).resolves.toEqual([])
      await expect(reopened.session('session', 'local-personal')).resolves.toMatchObject({
        scenario_policy: 'project-read-only'
      })
      await expect(reopened.session('session', 'other-workspace')).resolves.toBeNull()
      await expect(
        reopened.updateSession({
          id: 'session',
          workspaceId: 'local-personal',
          scenarioPolicy: null
        } as Parameters<BusinessRepository['updateSession']>[0])
      ).rejects.toThrow('BUSINESS_SCENARIO_POLICY_IMMUTABLE')
      await expect(reopened.session('session', 'local-personal')).resolves.toMatchObject({
        scenario_policy: 'project-read-only'
      })
      await expect(
        reopened.createSession({
          id: 'invalid',
          title: 'Invalid',
          mode: 'chat',
          createdAt: 2,
          updatedAt: 2,
          workspaceId: 'local-personal',
          scenarioPolicy: 'unknown' as 'project-read-only'
        })
      ).rejects.toThrow('INVALID_BUSINESS_SCENARIO_POLICY')
    } finally {
      await reopened.close()
    }
  })

  it('allows only local read tools for the exact persisted project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-scenario-policy-root-'))
    roots.push(root)
    const other = await mkdtemp(join(tmpdir(), 'ola-scenario-policy-other-'))
    roots.push(other)
    const session = {
      scenario_policy: 'project-read-only' as const,
      working_folder: root,
      ssh_connection_id: null
    }
    await expect(
      assertScenarioToolPolicy(run(['Read', 'Grep'], { workingDirectory: root }), session)
    ).resolves.toBeUndefined()
    await expect(
      assertScenarioToolPolicy(run(['Read', 'Write'], { workingDirectory: root }), session)
    ).rejects.toThrow('SCENARIO_TOOL_FORBIDDEN')
    await expect(
      assertScenarioToolPolicy(run(['Read'], { workingDirectory: other }), session)
    ).rejects.toThrow('SCENARIO_PROJECT_MISMATCH')
    await expect(
      assertScenarioToolPolicy(
        run(['Read'], { workingDirectory: root, sshConnectionId: 'ssh-other' }),
        session
      )
    ).rejects.toThrow('SCENARIO_PROJECT_MISMATCH')
  })

  it('allows SSH file reads only for the bound connection and remote folder', async () => {
    const session = {
      scenario_policy: 'ssh-read-only' as const,
      working_folder: '/srv/project',
      ssh_connection_id: 'ssh-1'
    }
    await expect(
      assertScenarioToolPolicy(
        run(['Read', 'LS'], { workingDirectory: '/srv/project', sshConnectionId: 'ssh-1' }),
        session
      )
    ).resolves.toBeUndefined()
    await expect(
      assertScenarioToolPolicy(
        run(['Bash'], { workingDirectory: '/srv/project', sshConnectionId: 'ssh-1' }),
        session
      )
    ).rejects.toThrow('SCENARIO_TOOL_FORBIDDEN')
    await expect(
      assertScenarioToolPolicy(
        run(['Read'], { workingDirectory: '/srv/project', sshConnectionId: 'ssh-2' }),
        session
      )
    ).rejects.toThrow('SCENARIO_PROJECT_MISMATCH')
    await expect(
      assertScenarioToolPolicy(
        run(['Read'], { workingDirectory: '/srv/project', sshConnectionId: 'ssh-1' }),
        { ...session, scenario_policy: 'invalid' as 'ssh-read-only' }
      )
    ).rejects.toThrow('SCENARIO_POLICY_INVALID')
  })

  it('allows a materials report without a project only when it has no tools', async () => {
    const session = {
      scenario_policy: 'materials-no-tools' as const,
      working_folder: null,
      ssh_connection_id: null
    }
    await expect(assertScenarioToolPolicy(run([]), session)).resolves.toBeUndefined()
    await expect(assertScenarioToolPolicy(run(['Read']), session)).rejects.toThrow(
      'SCENARIO_TOOL_FORBIDDEN'
    )
  })

  it('rejects a forbidden tool at Main submission before calling a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-scenario-policy-main-'))
    roots.push(root)
    const other = await mkdtemp(join(tmpdir(), 'ola-scenario-policy-main-other-'))
    roots.push(other)
    await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    const previousRoot = process.env.OLA_E2E_DATA_ROOT
    process.env.OLA_E2E_DATA_ROOT = root
    const runtime = new DesktopRuntime(join(root, 'desktop-runtime.json'))
    const restarted = new DesktopRuntime(join(root, 'desktop-runtime.json'))
    try {
      await closeBusinessWriteCanary()
      const writer = businessWriteCanary()
      if (!writer) throw new Error('Expected TS business writer')
      await writer.createSession({
        id: 'session',
        title: 'Project review',
        mode: 'chat',
        createdAt: 1,
        updatedAt: 1,
        workspaceId: 'local-personal',
        workingFolder: root,
        scenarioPolicy: 'project-read-only'
      })
      await writer.createSession({
        id: 'materials-session',
        title: 'Materials report',
        mode: 'chat',
        createdAt: 2,
        updatedAt: 2,
        workspaceId: 'local-personal',
        scenarioPolicy: 'materials-no-tools'
      })
      await runtime.start(root)
      await expect(
        runtime.request('run.submit', run(['Write'], { workingDirectory: root }))
      ).rejects.toMatchObject({ code: 'SCENARIO_TOOL_FORBIDDEN' })
      await expect(
        runtime.request('run.submit', run(['Read'], { workingDirectory: other }))
      ).rejects.toMatchObject({ code: 'SCENARIO_PROJECT_MISMATCH' })
      await expect(
        runtime.request(
          'run.submit',
          run(['Read'], { sessionId: 'materials-session', workingDirectory: root })
        )
      ).rejects.toMatchObject({ code: 'SCENARIO_TOOL_FORBIDDEN' })
      await runtime.stop()
      await closeBusinessWriteCanary()
      await restarted.start(root)
      await expect(
        restarted.request('run.submit', run(['Write'], { workingDirectory: root }))
      ).rejects.toMatchObject({ code: 'SCENARIO_TOOL_FORBIDDEN' })
      await expect(
        restarted.request(
          'run.submit',
          run(['Read'], { sessionId: 'materials-session', workingDirectory: root })
        )
      ).rejects.toMatchObject({ code: 'SCENARIO_TOOL_FORBIDDEN' })
    } finally {
      await runtime.stop()
      await restarted.stop()
      await closeBusinessWriteCanary()
      if (previousRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
      else process.env.OLA_E2E_DATA_ROOT = previousRoot
    }
  })
})

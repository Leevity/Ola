import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  agentDesktopEnv,
  agentDesktopFailure,
  mayRetrySafely,
  parseAgentDesktopEnvelope,
  parseAgentDesktopStatus,
  runAgentDesktop,
  verifyAgentDesktopTrust,
  type AgentDesktopReply
} from '../../src/main/agent-desktop/cli-client'
import {
  agentDesktopBinaryName,
  agentDesktopTripleKey
} from '../../src/main/agent-desktop/detector'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))

const fixturePath = resolve('tests/fixtures/fake-agent-desktop.mjs')

/**
 * The fixture is a script, so the host interpreter is the executable and the script becomes the
 * first argument. Windows cannot spawn a shebang at all, and running every platform this way keeps
 * one spawn shape in the contract tests instead of a POSIX-only and a Windows-only one.
 */
function fixtureSpawn(argv: string[]): { binaryPath: string; argv: string[] } {
  return { binaryPath: process.execPath, argv: [fixturePath, ...argv] }
}

/** Every code in agent-desktop v1.1.0's own skill documentation. */
const UPSTREAM_ERROR_CODES = [
  'ACTION_FAILED',
  'ACTION_NOT_SUPPORTED',
  'AMBIGUOUS_TARGET',
  'APP_NOT_FOUND',
  'APP_UNRESPONSIVE',
  'ELEMENT_NOT_FOUND',
  'INTERNAL',
  'INVALID_ARGS',
  'NOTIFICATION_NOT_FOUND',
  'PERM_DENIED',
  'PLATFORM_NOT_SUPPORTED',
  'POLICY_DENIED',
  'SNAPSHOT_NOT_FOUND',
  'STALE_REF',
  'TIMEOUT',
  'WINDOW_NOT_FOUND'
]

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ola-agent-desktop-'))
})

function calls(): Array<{ argv: string[]; home: string | null }> {
  try {
    return readFileSync(join(home, 'calls.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; home: string | null })
  } catch {
    return []
  }
}

function clearCalls(): void {
  rmSync(join(home, 'calls.ndjson'), { force: true })
}

async function run(app: string): Promise<AgentDesktopReply> {
  clearCalls()
  return runAgentDesktop({
    ...fixtureSpawn([
      'launch',
      app,
      '--session',
      'ola-test',
      '--agent-id',
      'ola-main',
      '--timeout',
      '1000'
    ]),
    env: { AGENT_DESKTOP_HOME: home },
    timeoutMs: 8_000,
    signal: new AbortController().signal,
    pinned: false
  })
}

describe('agent-desktop CLI client', () => {
  it('runs the pinned launch contract and returns the parsed envelope', async () => {
    const reply = await run('fake-ok')
    expect(reply.ok).toBe(true)
    expect(reply.data.pid).toBe(4242)
    expect(reply.exitCode).toBe(0)
    expect(calls()).toHaveLength(1)
    expect(calls()[0].argv).toEqual([
      'launch',
      'fake-ok',
      '--session',
      'ola-test',
      '--agent-id',
      'ola-main',
      '--timeout',
      '1000'
    ])
    expect(calls()[0].home).toBe(home)
  })

  // The client never decides to retry; it only reports. That keeps one audited retry entrance in
  // the tool layer, so a delivery the CLI cannot prove is not re-sent by two owners.
  it('reports retry-safety without acting on it', async () => {
    const safe = await run('fake-perm')
    expect(safe.code).toBe('PERM_DENIED')
    expect(mayRetrySafely(safe)).toBe(true)
    expect(calls()).toHaveLength(1)

    const unsafe = await run('fake-unsafe')
    expect(unsafe.code).toBe('ACTION_FAILED')
    expect(unsafe.disposition.delivery).toBe('delivered_unverified')
    expect(mayRetrySafely(unsafe)).toBe(false)
    expect(calls()).toHaveLength(1)
  })

  it('classifies every process-level failure without throwing', async () => {
    expect((await run('fake-bad-json')).code).toBe('AGENT_DESKTOP_BAD_ENVELOPE')
    expect((await run('fake-args-error')).code).toBe('INVALID_ARGS')
    expect((await run('fake-empty')).code).toBe('AGENT_DESKTOP_EMPTY_RESULT')
    expect((await run('fake-overflow')).code).toBe('AGENT_DESKTOP_OUTPUT_TOO_LARGE')
  })

  it('bounds a process that stops talking', async () => {
    const reply = await runAgentDesktop({
      ...fixtureSpawn(['launch', 'fake-hang']),
      env: { AGENT_DESKTOP_HOME: home },
      timeoutMs: 400,
      signal: new AbortController().signal,
      pinned: false
    })
    expect(reply.code).toBe('TIMEOUT')
    expect(mayRetrySafely(reply)).toBe(false)
  })

  it('refuses to start a process for an aborted run', async () => {
    const controller = new AbortController()
    controller.abort()
    const reply = await runAgentDesktop({
      ...fixtureSpawn(['launch', 'fake-ok']),
      env: { AGENT_DESKTOP_HOME: home },
      timeoutMs: 5_000,
      signal: controller.signal,
      pinned: false
    })
    expect(reply.code).toBe('CANCELED')
    expect(calls()).toHaveLength(0)
    expect(existsSync(join(home, 'calls.ndjson'))).toBe(false)
  })

  it('refuses to start an unverifiable binary', async () => {
    const missing = await runAgentDesktop({
      binaryPath: join(home, 'nowhere'),
      argv: ['launch', 'fake-ok'],
      env: { AGENT_DESKTOP_HOME: home },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      pinned: false
    })
    expect(missing.code).toBe('AGENT_DESKTOP_TRUST_CHECK_FAILED')

    const notExecutable = join(home, 'agent-desktop')
    writeFileSync(notExecutable, '#!/usr/bin/env node\n')
    chmodSync(notExecutable, 0o644)
    if (process.platform !== 'win32') {
      await expect(verifyAgentDesktopTrust(notExecutable, { pinned: false })).rejects.toThrow(
        /not executable/
      )
    }
    expect(calls()).toHaveLength(0)
  })

  it('rejects a binary that is not the pinned build', async () => {
    const directory = join(
      home,
      'resources',
      'agent-desktop',
      agentDesktopTripleKey(process.platform, process.arch)
    )
    mkdirSync(directory, { recursive: true })
    const staged = join(directory, agentDesktopBinaryName(process.platform))
    copyFileSync(fixturePath, staged)
    chmodSync(staged, 0o755)
    // A path shaped like the shipped tree is treated as pinned, so the hash decides.
    await expect(verifyAgentDesktopTrust(staged, { pinned: true })).rejects.toThrow(/hash changed/)
    const reply = await runAgentDesktop({
      binaryPath: staged,
      argv: ['launch', 'fake-ok'],
      env: { AGENT_DESKTOP_HOME: home },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      pinned: true
    })
    expect(reply.code).toBe('AGENT_DESKTOP_TRUST_CHECK_FAILED')
    expect(calls()).toHaveLength(0)
  })

  it('forwards the desktop session coordinates and nothing secret', () => {
    const env = agentDesktopEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/user',
        DISPLAY: ':0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/x',
        ANTHROPIC_API_KEY: 'secret',
        OLA_SESSION_TOKEN: 'secret',
        HTTPS_PROXY: 'http://internal'
      } as NodeJS.ProcessEnv,
      { AGENT_DESKTOP_HOME: '/abs/home' }
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.DISPLAY).toBe(':0')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/x')
    expect(env.AGENT_DESKTOP_HOME).toBe('/abs/home')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OLA_SESSION_TOKEN).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('passes upstream error codes through unchanged', () => {
    for (const code of UPSTREAM_ERROR_CODES) {
      const reply = parseAgentDesktopEnvelope(
        JSON.stringify({
          version: '2.6',
          ok: false,
          command: 'launch',
          error: {
            code,
            message: `${code} message`,
            suggestion: `${code} suggestion`,
            disposition: { delivery: 'not_delivered', retry: 'safe' }
          }
        })
      )
      expect(reply.ok).toBe(false)
      expect(reply.code).toBe(code)
      expect(reply.suggestion).toBe(`${code} suggestion`)
    }
    const bare = parseAgentDesktopEnvelope('{"version":"2.6","ok":false,"command":"launch"}')
    expect(bare.code).toBe('INTERNAL')
  })

  it('only treats not_delivered as safe to repeat', () => {
    const reply = (retry: string | null): AgentDesktopReply => ({
      ok: false,
      code: 'X',
      message: null,
      suggestion: null,
      data: {},
      disposition: { delivery: null, retry },
      exitCode: 1
    })
    expect(mayRetrySafely(reply('safe'))).toBe(true)
    expect(mayRetrySafely(reply('unsafe'))).toBe(false)
    expect(mayRetrySafely(reply(null))).toBe(false)
    expect(mayRetrySafely({ ...reply('safe'), ok: true })).toBe(false)
  })

  it('renders a failure the model can branch on', () => {
    const reply = parseAgentDesktopEnvelope(
      JSON.stringify({
        version: '2.6',
        ok: false,
        command: 'click',
        error: {
          code: 'AMBIGUOUS_TARGET',
          message: 'two matching elements',
          suggestion: 'narrow the selector',
          disposition: { delivery: 'not_delivered', retry: 'safe' }
        }
      })
    )
    expect(agentDesktopFailure(reply)).toBe(
      'agent-desktop AMBIGUOUS_TARGET: two matching elements: delivery=not_delivered: retry=safe: narrow the selector'
    )
  })

  it('reads the permission state the platform gate cannot answer about itself', () => {
    const status = parseAgentDesktopStatus(
      parseAgentDesktopEnvelope(
        JSON.stringify({
          version: '2.6',
          ok: true,
          command: 'status',
          data: {
            platform: 'macos',
            version: '1.1.0',
            state_root: '/var/folders/x',
            supported_surfaces: ['window', 'menu'],
            permissions: { accessibility: { state: 'denied' } }
          }
        })
      )
    )
    expect(status).toEqual({
      platform: 'macos',
      version: '1.1.0',
      stateRoot: '/var/folders/x',
      accessibility: 'denied',
      supportedSurfaces: ['window', 'menu']
    })
    expect(parseAgentDesktopStatus(parseAgentDesktopEnvelope('{"ok":false}'))).toBeNull()
  })
})

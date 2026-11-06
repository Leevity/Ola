// ── MCP System — host-side preflight ──
//
// Some stdio MCP servers are not self-contained: they shell out to engines the user installed
// (Hopper, JADX, tshark, adb) and require a runtime newer than the one Ola was built against.
// Discovering that after the child has spawned means a stack trace in a log the user will never
// open. This module answers the same two questions before `connect()` is allowed to spawn:
// is the interpreter the child will use in range, and are the declared binaries present?

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import { matchesNodeRange, parseVersion } from '../../shared/semver-range-lite'
import type { McpServerConfig, McpServerDiagnostic } from './mcp-types'

const PROBE_TIMEOUT_MS = 5_000

/**
 * Resolve an executable the way `child_process` would when `shell` is not used: PATH entries
 * first, then `PATHEXT` on Windows. Returns the absolute path, or `undefined` when absent.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  // An absolute or relative path wins over PATH lookup, matching spawn semantics.
  const direct = command.includes('/') || command.includes('\\')
  if (direct) return existsSync(command) ? command : undefined
  const pathEntry = env.PATH ?? env.Path ?? ''
  const extensions =
    platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of pathEntry.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, command + extension)
      if (candidate.includes(sep) && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Ask the interpreter that the MCP child will actually run what its version is.
 * `process.versions.node` is deliberately not used: Electron pins its own Node, and the server is
 * spawned from PATH, so the two answers describe different processes.
 */
async function probeNodeVersion(nodeCommand: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(nodeCommand, ['-p', 'process.version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(undefined)
      return
    }
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, PROBE_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      // A hostile launcher could print forever; stop reading after a probe-sized window.
      if (output.length > 256) {
        child.kill()
        finish(undefined)
      }
    })
    child.on('error', () => finish(undefined))
    child.on('close', (code) => finish(code === 0 ? output.trim() : undefined))
  })
}

/**
 * Run the declared gates for one server. `undefined` means "nothing blocks the connection", which
 * also covers a config with no preflight and any probe that could not be read — an unreadable
 * probe is unknown, and unknown must not be reported as a failure.
 */
export async function runMcpPreflight(
  config: McpServerConfig,
  options: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    probe?: (nodeCommand: string) => Promise<string | undefined>
  } = {}
): Promise<McpServerDiagnostic | undefined> {
  const preflight = config.preflight
  // A remote server's engines live on its host; probing this machine says nothing about it.
  if (!preflight || config.transport !== 'stdio') return undefined

  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const nodeCommand = preflight.nodeCommand?.trim()

  if (nodeCommand && preflight.nodeRange?.trim()) {
    const resolved = resolveCommandOnPath(nodeCommand, env, platform)
    if (!resolved) {
      return {
        code: 'COMMAND_MISSING',
        detail: nodeCommand,
        hint: `Install Node.js or set the server command to an interpreter that exists on PATH.`
      }
    }
    const probe = options.probe ?? probeNodeVersion
    const raw = await probe(nodeCommand)
    const version = raw ? parseVersion(raw) : null
    // Unparsable or missing probe output stays unknown: never block on a probe we could not read.
    if (version) {
      const verdict = matchesNodeRange(raw ?? '', preflight.nodeRange)
      if (verdict === 'unsatisfied') {
        return {
          code: 'NODE_VERSION_UNSUPPORTED',
          detail: `v${version.major}.${version.minor}.${version.patch}${version.prerelease ? `-${version.prerelease}` : ''}`,
          hint: `This server requires Node ${preflight.nodeRange}. Install a matching runtime, or choose Ignore preflight to connect anyway.`
        }
      }
    }
  }

  for (const command of preflight.requiredCommands ?? []) {
    const trimmed = command.trim()
    if (!trimmed) continue
    if (!resolveCommandOnPath(trimmed, env, platform)) {
      return {
        code: 'COMMAND_MISSING',
        detail: trimmed,
        hint: `Install ${trimmed} and make sure it is on PATH, or choose Ignore preflight to connect without it.`
      }
    }
  }

  return undefined
}

/** Whether a diagnostic should stop `connect()`. `TOOL_NOT_EXPOSABLE` never does — it is a report. */
export function isBlockingPreflightFailure(diagnostic: McpServerDiagnostic | undefined): boolean {
  if (!diagnostic) return false
  return diagnostic.code !== 'TOOL_NOT_EXPOSABLE'
}

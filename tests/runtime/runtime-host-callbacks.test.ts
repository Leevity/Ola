import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { FrameDecoder, encodeFrame } from '../../src/runtime/host/framing'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { RuntimeServer } from '../../src/runtime/host/runtime-server'
import { RunScheduler } from '../../src/runtime/scheduler/run-scheduler'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import {
  MIN_RUNTIME_PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeError
} from '../../src/shared/runtime/contracts'

const TOKEN = 'a'.repeat(64)

async function harness(options: { allowHost?: boolean; authorityViaHost?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ola-host-callbacks-'))
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\ola-test-${randomUUID()}` : join(directory, 's')
  const journal = new RunJournal(join(directory, 'db'))
  const scheduler = new RunScheduler(
    journal,
    async (_run, context) => {
      await context.emit('message.delta', { text: 'ok' })
    },
    async () => undefined
  )
  let serverRef: RuntimeServer | undefined
  const server = new RuntimeServer(
    scheduler,
    TOKEN,
    {
      workspaceIds: async () => {
        if (options.authorityViaHost && serverRef) {
          const answer = await serverRef.requestHost<{ workspaceIds: string[] }>(
            'workspace.authority',
            {}
          )
          return new Set(answer.workspaceIds)
        }
        return new Set(['local-personal'])
      }
    },
    { allowHost: options.allowHost === true }
  )
  serverRef = server
  await scheduler.initialize()
  await server.listen(endpoint)
  const clients: RuntimeClient[] = []
  const client = async (handler?: (method: string, params: unknown) => Promise<unknown>) => {
    const peer = new RuntimeClient()
    if (handler) peer.onRequest(handler)
    await peer.connect(endpoint, TOKEN)
    clients.push(peer)
    return peer
  }
  return {
    directory,
    endpoint,
    server,
    scheduler,
    journal,
    client,
    close: async () => {
      for (const peer of clients) peer.close()
      await server.close()
      await scheduler.stop()
      await journal.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** A version 1 peer, spoken by hand because RuntimeClient always offers the current version. */
async function observerHandshake(endpoint: string, version: number, capabilities: string[]) {
  const socket = connect(endpoint)
  const decoder = new FrameDecoder()
  const frames: Record<string, unknown>[] = []
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) frames.push(frame as Record<string, unknown>)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.write(
    encodeFrame({ id: '1', method: 'hello', params: { token: TOKEN, version, capabilities } })
  )
  await expect.poll(() => frames.length).toBeGreaterThan(0)
  return { socket, frames }
}

describe('runtime host callbacks', () => {
  it('round-trips a host request and preserves the handler result', async () => {
    const h = await harness({ allowHost: true })
    try {
      const seen: Array<{ method: string; params: unknown }> = []
      const peer = await h.client(async (method, params) => {
        seen.push({ method, params })
        return { approved: true, echo: params }
      })
      expect([...peer.capabilities]).toContain('host')
      await expect(
        h.server.requestHost('authorize', { runId: 'r1', workspaceId: 'local-personal' })
      ).resolves.toEqual({
        approved: true,
        echo: { runId: 'r1', workspaceId: 'local-personal' }
      })
      expect(seen).toEqual([
        { method: 'authorize', params: { runId: 'r1', workspaceId: 'local-personal' } }
      ])
    } finally {
      await h.close()
    }
  })

  it('refuses host authority unless the server was built for isolation', async () => {
    const h = await harness()
    try {
      const peer = await h.client(async () => ({ approved: true }))
      expect([...peer.capabilities]).not.toContain('host')
      await expect(h.server.requestHost('authorize', {})).rejects.toThrow('HOST_UNAVAILABLE')
    } finally {
      await h.close()
    }
  })

  it('never hands host authority to a version 1 observer', async () => {
    const h = await harness({ allowHost: true })
    try {
      const { socket, frames } = await observerHandshake(h.endpoint, MIN_RUNTIME_PROTOCOL_VERSION, [
        'runs',
        'host'
      ])
      try {
        const result = frames[0].result as { version: number; capabilities: string[] }
        expect(result.version).toBe(MIN_RUNTIME_PROTOCOL_VERSION)
        expect(result.capabilities).toContain('runs')
        expect(result.capabilities).not.toContain('host')
        await expect(h.server.requestHost('authorize', {})).rejects.toThrow('HOST_UNAVAILABLE')
      } finally {
        socket.destroy()
      }
    } finally {
      await h.close()
    }
  })

  it('rejects a second host so credential authority has exactly one owner', async () => {
    const h = await harness({ allowHost: true })
    try {
      await h.client(async () => null)
      const second = new RuntimeClient()
      second.onRequest(async () => null)
      await expect(second.connect(h.endpoint, TOKEN)).rejects.toThrow('HOST_ALREADY_CONNECTED')
      second.close()
    } finally {
      await h.close()
    }
  })

  it('propagates a handler failure as its own error code', async () => {
    const h = await harness({ allowHost: true })
    try {
      await h.client(async () => {
        throw new RuntimeError('WORKSPACE_FORBIDDEN')
      })
      await expect(h.server.requestHost('authorize', {})).rejects.toThrow('WORKSPACE_FORBIDDEN')
    } finally {
      await h.close()
    }
  })

  it('answers with an error when the host registered no handler', async () => {
    const h = await harness({ allowHost: true })
    try {
      await h.client()
      await expect(h.server.requestHost('authorize', {})).rejects.toThrow(
        'HOST_CALLBACK_UNAVAILABLE'
      )
    } finally {
      await h.close()
    }
  })

  it('fails pending host requests when the host disconnects', async () => {
    const h = await harness({ allowHost: true })
    try {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const peer = await h.client(async () => {
        await gate
        return null
      })
      const pending = h.server.requestHost('tool.executeAll', {})
      const assertion = expect(pending).rejects.toThrow('HOST_UNAVAILABLE')
      peer.close()
      await assertion
      release?.()
    } finally {
      await h.close()
    }
  })

  it('times out a host request instead of hanging the run forever', async () => {
    const h = await harness({ allowHost: true })
    try {
      await h.client(() => new Promise(() => undefined))
      await expect(h.server.requestHost('authorize', {}, 40)).rejects.toThrow(
        'HOST_REQUEST_TIMEOUT'
      )
    } finally {
      await h.close()
    }
  })

  /**
   * The regression this guards: `run.list` dispatch awaits a host callback, and
   * that dispatch occupies the socket's serialized request queue. If the host's
   * answer were queued behind it, the run would wait for itself forever.
   *
   * The nested request is deliberately not awaited inside the handler: awaiting
   * it would be a genuine circular wait, not the queueing bug under test.
   */
  it('serves a callback from inside a dispatch without deadlocking', async () => {
    const h = await harness({ allowHost: true, authorityViaHost: true })
    try {
      let nested: Promise<unknown> | undefined
      const peer = await h.client(async (method) => {
        if (method === 'workspace.authority') {
          nested = peer.request('ping')
          return { workspaceIds: ['local-personal'] }
        }
        return null
      })
      await expect(
        peer.request('run.list', { workspaceId: 'local-personal' })
      ).resolves.toBeInstanceOf(Array)
      await expect(nested).resolves.toEqual({ version: RUNTIME_PROTOCOL_VERSION })
    } finally {
      await h.close()
    }
  })

  it('keeps the current version negotiable for a host peer', async () => {
    const h = await harness({ allowHost: true })
    try {
      const { socket, frames } = await observerHandshake(h.endpoint, RUNTIME_PROTOCOL_VERSION, [
        'runs',
        'host'
      ])
      try {
        const result = frames[0].result as { version: number; capabilities: string[] }
        expect(result.version).toBe(RUNTIME_PROTOCOL_VERSION)
        expect(result.capabilities).toContain('host')
      } finally {
        socket.destroy()
      }
    } finally {
      await h.close()
    }
  })
})

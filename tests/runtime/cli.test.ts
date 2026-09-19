import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { publishDesktopRuntimeConnection } from '../../src/runtime/host/desktop-connection'

it('routes the default project CLI to the built TS runtime instead of the Native Worker', async () => {
  const exec = promisify(execFile)
  const result = await exec(process.execPath, ['scripts/run-ts-runtime-cli.mjs', 'help'])
  expect(result.stdout).toContain('Ola staged TS runtime')
  expect(result.stdout).toContain('serve --data-dir')
  expect(result.stdout).not.toContain('OLA_NATIVE_WORKER_PATH')
}, 15000)

it('builds and runs an independent CLI service using an isolated mock model, reconnects after restart', async () => {
  const exec = promisify(execFile)
  await exec(process.execPath, ['scripts/build-ts-runtime.mjs'])
  const dir = await mkdtemp(join(tmpdir(), 'ola-cli-e2e-'))
  let calls = 0
  let pauseNext = false
  const model = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer test-only-key')
    calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (pauseNext) {
      response.flushHeaders()
      return
    }
    response.end('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r))
  const port = (model.address() as { port: number }).port
  const cli = resolve('out/runtime/cli.mjs')
  const start = () =>
    spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--data-dir',
        dir,
        '--provider',
        'local',
        '--model',
        'mock',
        '--base-url',
        `http://127.0.0.1:${port}/v1`,
        '--api-key-env',
        'OLA_TEST_KEY'
      ],
      { env: { ...process.env, OLA_TEST_KEY: 'test-only-key' }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  let daemon = start()
  const waitReady = async () => {
    await expect
      .poll(async () => {
        try {
          const result = JSON.parse(await readFile(join(dir, 'runtime-v2/connection.json'), 'utf8'))
          return result.pid === daemon.pid
        } catch {
          return false
        }
      })
      .toBe(true)
  }
  const stop = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    daemon.kill('SIGTERM')
    await exited
  }
  try {
    await waitReady()
    const desktopConnection = JSON.parse(
      await readFile(join(dir, 'runtime-v2/connection.json'), 'utf8')
    ) as { endpoint: string; token: string }
    const desktopDescriptorPath = join(dir, 'desktop-runtime.json')
    await publishDesktopRuntimeConnection(desktopConnection, desktopDescriptorPath)
    const sharedList = await exec(process.execPath, [cli, 'list'], {
      env: { ...process.env, OLA_DESKTOP_RUNTIME_DESCRIPTOR: desktopDescriptorPath }
    })
    expect(JSON.parse(sharedList.stdout)).toEqual([])
    await writeFile(join(dir, 'prompt.txt'), 'hello')
    const result = await exec(process.execPath, [
      cli,
      'run',
      '--data-dir',
      dir,
      '--provider',
      'local',
      '--model',
      'mock',
      '--prompt-file',
      join(dir, 'prompt.txt')
    ])
    const runId = result.stdout.trim()
    const watched = await exec(process.execPath, [cli, 'watch', '--data-dir', dir, '--run', runId])
    expect(watched.stdout).toContain('completed')
    expect(watched.stdout).toContain('done')
    expect(watched.stdout).not.toContain('test-only-key')
    expect(calls).toBe(1)
    await stop()
    daemon = start()
    await waitReady()
    const list = await exec(process.execPath, [cli, 'list', '--data-dir', dir])
    expect(JSON.parse(list.stdout)[0].runId).toBe(runId)
    expect(calls).toBe(1)
    pauseNext = true
    const pending = await exec(process.execPath, [
      cli,
      'run',
      '--data-dir',
      dir,
      '--provider',
      'local',
      '--model',
      'mock',
      '--prompt-file',
      join(dir, 'prompt.txt')
    ])
    await expect.poll(() => calls).toBe(2)
    const crashed = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    daemon.kill('SIGKILL')
    await crashed
    daemon = start()
    await waitReady()
    const recovered = await exec(process.execPath, [cli, 'list', '--data-dir', dir])
    const interrupted = JSON.parse(recovered.stdout).find(
      (run: { runId: string }) => run.runId === pending.stdout.trim()
    )
    expect(interrupted.status).toBe('interrupted')
    expect(calls).toBe(2)
  } finally {
    await stop()
    await new Promise<void>((r) => model.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)

it('executes a model-requested file read only inside the explicitly configured CLI workspace', async () => {
  const exec = promisify(execFile)
  await exec(process.execPath, ['scripts/build-ts-runtime.mjs'])
  const dir = await mkdtemp(join(tmpdir(), 'ola-cli-tools-e2e-'))
  const workspace = await mkdtemp(join(tmpdir(), 'ola-cli-workspace-'))
  const requests: Array<{
    tools?: Array<{ function?: { name?: string } }>
    messages?: unknown[]
  }> = []
  const model = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 1) {
        response.end(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read-safe","function":{"name":"read_text_file","arguments":"{\\"path\\":\\"safe.txt\\"}"}}]}}]}\n\ndata: [DONE]\n\n'
        )
        return
      }
      response.end('data: {"choices":[{"delta":{"content":"read complete"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r))
  const port = (model.address() as { port: number }).port
  const cli = resolve('out/runtime/cli.mjs')
  const daemon = spawn(
    process.execPath,
    [
      cli,
      'serve',
      '--data-dir',
      dir,
      '--provider',
      'local',
      '--model',
      'mock',
      '--base-url',
      `http://127.0.0.1:${port}/v1`,
      '--workspace-root',
      workspace,
      '--allow-write'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const stop = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    daemon.kill('SIGTERM')
    await exited
  }
  try {
    await expect
      .poll(async () => {
        try {
          return (
            JSON.parse(await readFile(join(dir, 'runtime-v2/connection.json'), 'utf8')).pid ===
            daemon.pid
          )
        } catch {
          return false
        }
      })
      .toBe(true)
    await writeFile(join(workspace, 'safe.txt'), 'workspace-only value')
    const prompt = join(dir, 'prompt.txt')
    await writeFile(prompt, 'read the safe file')
    const submitted = await exec(process.execPath, [
      cli,
      'run',
      '--data-dir',
      dir,
      '--provider',
      'local',
      '--model',
      'mock',
      '--prompt-file',
      prompt,
      '--tools',
      'read_text_file'
    ])
    const watched = await exec(process.execPath, [
      cli,
      'watch',
      '--data-dir',
      dir,
      '--run',
      submitted.stdout.trim()
    ])
    expect(watched.stdout).toContain('tool.result')
    expect(watched.stdout).toContain('workspace-only value')
    expect(watched.stdout).toContain('read complete')
    expect(requests).toHaveLength(2)
    expect(requests[0].tools?.map((tool) => tool.function?.name)).toEqual(['read_text_file'])
    expect(JSON.stringify(requests[1].messages)).toContain('workspace-only value')
  } finally {
    await stop()
    await new Promise<void>((r) => model.close(() => r()))
    await rm(dir, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
}, 15000)

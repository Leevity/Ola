import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'

const projectRoot = resolve(import.meta.dirname, '..')
const testRoot = await mkdtemp(join(tmpdir(), 'ola-electron-workspace-ipc-'))
try {
  const entry = join(testRoot, 'workspace-ipc-main.cjs')
  await build({
    entryPoints: [join(projectRoot, 'tests/electron/workspace-ipc-main.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(electron, [entry], {
      cwd: projectRoot,
      env: { ...process.env, OLA_ELECTRON_IPC_TEST_ROOT: testRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let timedOut = false
    let forceTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL')
        // Only close this test child's pipes; orphaned Chromium helpers must
        // not keep the test runner alive after the failed deadline.
        child.stdout.destroy()
        child.stderr.destroy()
        reject(new Error(`Electron workspace IPC test timed out\n${output}`))
      }, 5000)
    }, 30_000)
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk.toString()
        const destination = stream === child.stdout ? process.stdout : process.stderr
        destination.write(chunk)
      })
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      if (timedOut) reject(new Error(`Electron workspace IPC test timed out\n${output}`))
      else resolveResult({ code, signal, output })
    })
  })
  if (result.code !== 0) throw new Error(result.output || `Electron exited: ${result.signal}`)
} finally {
  await rm(testRoot, { recursive: true, force: true })
}

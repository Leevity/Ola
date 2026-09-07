/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

const DEV_PORT = 5173

async function clearViteCache(projectDir) {
  const viteCacheDir = path.join(projectDir, 'node_modules', '.vite')
  await rm(viteCacheDir, { recursive: true, force: true })
}

const WORKER_SOURCE_EXTENSIONS = new Set(['.cs', '.csproj', '.props', '.targets', '.json'])
const WORKER_SOURCE_SKIP_DIRS = new Set(['bin', 'obj', '.git'])

function newestWorkerSourceMtime(sourceRoot) {
  if (!existsSync(sourceRoot)) return 0

  let newest = 0
  function visit(directory) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory() && WORKER_SOURCE_SKIP_DIRS.has(entry.name)) continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(absolutePath)
        continue
      }
      if (!WORKER_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      try {
        newest = Math.max(newest, statSync(absolutePath).mtimeMs)
      } catch {
        // A source file can change during startup; the next launch will retry.
      }
    }
  }

  visit(sourceRoot)
  return newest
}

function hasFreshWorkerBinary(candidates, sourceRoots) {
  const newestSource = Math.max(...sourceRoots.map(newestWorkerSourceMtime))
  return candidates.some((candidate) => {
    if (!existsSync(candidate)) return false
    try {
      return statSync(candidate).mtimeMs >= newestSource
    } catch {
      return false
    }
  })
}

async function ensurePortAvailable(port) {
  const hosts = ['127.0.0.1', '::1']

  for (const host of hosts) {
    await new Promise((resolve, reject) => {
      const server = net.createServer()

      server.once('error', (error) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')
        ) {
          resolve()
          return
        }

        server.close()
        reject(error)
      })

      server.once('listening', () => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve()
        })
      })

      server.listen(port, host)
    })
  }
}

async function ensureNativeWorker(projectDir) {
  const workerDir = path.join(projectDir, 'resources', 'native-worker')
  const workerExe = path.join(workerDir, 'Ola.Native.Worker.exe')
  const workerBin = path.join(workerDir, 'Ola.Native.Worker')
  const codeGraphDir = path.join(workerDir, 'codegraph-worker')
  const codeGraphExe = path.join(codeGraphDir, 'Ola.CodeGraph.Worker.exe')
  const codeGraphBin = path.join(codeGraphDir, 'Ola.CodeGraph.Worker')
  const nativeCandidates = [workerBin, workerExe]
  const codeGraphCandidates = [codeGraphBin, codeGraphExe]
  const nativeReady = nativeCandidates.some((candidate) => existsSync(candidate))
  const codeGraphReady = codeGraphCandidates.some((candidate) => existsSync(candidate))
  const nativeFresh = hasFreshWorkerBinary(nativeCandidates, [
    path.join(projectDir, 'sidecars', 'Ola.Native.Worker'),
    path.join(projectDir, 'sidecars', 'Ola.Worker.Runtime')
  ])
  const codeGraphFresh = hasFreshWorkerBinary(codeGraphCandidates, [
    path.join(projectDir, 'sidecars', 'Ola.CodeGraph.Worker'),
    path.join(projectDir, 'sidecars', 'Ola.CodeGraph.Core'),
    path.join(projectDir, 'sidecars', 'Ola.Worker.Runtime')
  ])

  if (nativeReady && codeGraphReady && nativeFresh && codeGraphFresh) {
    return
  }

  console.log(
    '[predev] Native worker is missing or stale, building it now (this may take a minute)...'
  )

  const result = spawnSync('npm', ['run', 'native:publish'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.status !== 0) {
    console.error(
      '[predev] Failed to build native worker. You can try manually: npm run native:publish'
    )
    process.exitCode = 1
    return
  }

  const builtNativeReady =
    existsSync(workerBin) || (process.platform === 'win32' && existsSync(workerExe))
  const builtCodeGraphReady =
    existsSync(codeGraphBin) || (process.platform === 'win32' && existsSync(codeGraphExe))
  if (!builtNativeReady || !builtCodeGraphReady) {
    console.error('[predev] Worker build completed but required binaries are missing.')
    process.exitCode = 1
    return
  }

  console.log('[predev] Native worker built successfully.')
}

async function main() {
  const projectDir = process.cwd()
  await ensureNativeWorker(projectDir)
  await clearViteCache(projectDir)

  try {
    await ensurePortAvailable(DEV_PORT)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
      console.error(
        `Port ${DEV_PORT} is already in use. Stop the existing dev server before running ` +
          '`npm run dev` so the app does not keep talking to stale renderer assets.'
      )
      process.exitCode = 1
      return
    }

    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

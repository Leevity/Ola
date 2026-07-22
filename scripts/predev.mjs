/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync } from 'node:fs'
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
  const nativeReady =
    existsSync(workerBin) || (process.platform === 'win32' && existsSync(workerExe))
  const codeGraphReady =
    existsSync(codeGraphBin) || (process.platform === 'win32' && existsSync(codeGraphExe))

  if (nativeReady && codeGraphReady) {
    return
  }

  console.log('[predev] Native worker not found, building it now (this may take a minute)...')

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

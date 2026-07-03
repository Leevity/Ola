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
  const workerBin = path.join(projectDir, 'resources', 'native-worker', 'Ola.Native.Worker')

  if (existsSync(workerBin)) {
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

  if (!existsSync(workerBin)) {
    console.error('[predev] Native worker build completed but binary not found at:', workerBin)
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

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { rm } from 'node:fs/promises'
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

async function main() {
  const projectDir = process.cwd()
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

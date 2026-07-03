import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const releaseRepo = process.env.OLA_RELEASE_REPO ?? 'Leevity/Ola'
const releaseTag = process.env.OLA_RELEASE_TAG ?? 'latest'
const syncIntervalMs = Number(process.env.OLA_RELEASE_SYNC_INTERVAL_MS ?? 60 * 60 * 1000)
const githubToken = process.env.OLA_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
const downloadsDir = path.join(process.cwd(), 'public', 'downloads')

const assetTargets = [
  {
    sourceName: 'Ola-win-amd64-setup.exe',
    targetName: 'Ola-Windows-Setup.exe'
  },
  {
    sourceName: 'Ola-linux-amd64.AppImage',
    targetName: 'Ola.AppImage'
  },
  {
    sourceName: 'Ola-linux-amd64.deb',
    targetName: 'Ola.deb'
  }
]

const requestHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Ola-docs-runtime'
}

if (githubToken) {
  requestHeaders.Authorization = `Bearer ${githubToken}`
}

let syncInProgress = false

function getReleaseEndpoint() {
  if (releaseTag === 'latest') {
    return `https://api.github.com/repos/${releaseRepo}/releases/latest`
  }

  return `https://api.github.com/repos/${releaseRepo}/releases/tags/${encodeURIComponent(releaseTag)}`
}

async function isUpToDate(filePath, expectedSize) {
  try {
    const file = await stat(filePath)
    return file.size === expectedSize
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function downloadAsset(asset, targetName) {
  const targetPath = path.join(downloadsDir, targetName)

  if (await isUpToDate(targetPath, asset.size)) {
    console.log(`[downloads] up-to-date: ${targetName}`)
    return
  }

  const tempPath = `${targetPath}.part`
  await unlink(tempPath).catch(() => {})

  console.log(`[downloads] downloading ${asset.name} -> ${targetName}`)

  const response = await fetch(asset.browser_download_url, {
    headers: requestHeaders,
    redirect: 'follow'
  })

  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${asset.name}: ${response.status} ${response.statusText}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
  await rename(tempPath, targetPath)

  console.log(`[downloads] downloaded ${targetName}`)
}

async function syncReleaseAssets() {
  if (syncInProgress) {
    console.log('[downloads] sync skipped: previous sync still running')
    return
  }

  syncInProgress = true

  try {
    await mkdir(downloadsDir, { recursive: true })

    const response = await fetch(getReleaseEndpoint(), {
      headers: requestHeaders,
      redirect: 'follow'
    })

    if (!response.ok) {
      throw new Error(`failed to query release metadata: ${response.status} ${response.statusText}`)
    }

    const release = await response.json()
    const releaseAssets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))

    for (const target of assetTargets) {
      const asset = releaseAssets.get(target.sourceName)

      if (!asset) {
        console.warn(`[downloads] asset not found in release: ${target.sourceName}`)
        continue
      }

      await downloadAsset(asset, target.targetName)
    }
  } catch (error) {
    console.error('[downloads] sync failed', error)
  } finally {
    syncInProgress = false
  }
}

function startBackgroundSync() {
  void syncReleaseAssets()

  if (!Number.isFinite(syncIntervalMs) || syncIntervalMs <= 0) {
    return
  }

  setInterval(() => {
    void syncReleaseAssets()
  }, syncIntervalMs)
}

const server = spawn(process.execPath, ['server.js'], {
  env: process.env,
  stdio: 'inherit'
})

server.on('error', (error) => {
  console.error('[runtime] failed to start Next server', error)
  process.exit(1)
})

server.on('exit', (code) => {
  process.exit(code ?? 0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!server.killed) {
      server.kill(signal)
    }
  })
}

startBackgroundSync()

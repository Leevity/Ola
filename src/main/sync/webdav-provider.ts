import type {
  SyncBundle,
  SyncConnectionTestResult,
  WebDavSyncConfig
} from '../../shared/sync-types'

export interface RemoteBundleState {
  bundle: SyncBundle | null
  etag: string | null
  lastModified: string | null
  updatedAt: number | null
}

export interface UploadRemoteBundleOptions {
  previousExists?: boolean
  previousEtag?: string | null
  previousLastModified?: string | null
}

export class RemoteStateChangedError extends Error {
  constructor() {
    super('Remote sync state changed before upload; retry sync before overwriting')
    this.name = 'RemoteStateChangedError'
  }
}

interface RemoteFileStat {
  exists: boolean
  etag: string | null
  lastModified: string | null
  updatedAt: number | null
}

const STATE_FILE_NAME = 'state.json.gz'

function ensureArrayBuffer(value: ArrayBuffer | SharedArrayBuffer): Buffer {
  return Buffer.from(value as ArrayBuffer)
}

function bufferToBody(buffer: Buffer): BodyInit {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function splitRemotePath(remotePath: string): string[] {
  return trimSlashes(remotePath)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function normalizeBaseUrl(serverUrl: string): URL {
  const trimmed = serverUrl.trim()
  if (!trimmed) throw new Error('WebDAV server URL is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebDAV server URL must start with http:// or https://')
  }
  return url
}

function buildUrl(serverUrl: string, remotePath: string): string {
  const base = normalizeBaseUrl(serverUrl)
  const baseParts = splitRemotePath(base.pathname)
  const remoteParts = splitRemotePath(remotePath)
  base.pathname = [...baseParts, ...remoteParts].map(encodeURIComponent).join('/')
  if (!base.pathname.startsWith('/')) base.pathname = `/${base.pathname}`
  return base.toString()
}

function buildCollectionUrl(config: WebDavSyncConfig): string {
  return buildUrl(config.serverUrl, config.remoteDir)
}

function buildStateUrl(config: WebDavSyncConfig): string {
  return buildUrl(config.serverUrl, `${config.remoteDir}/${STATE_FILE_NAME}`)
}

function buildBackupPath(config: WebDavSyncConfig, filename: string): string {
  return `${trimSlashes(config.remoteDir)}/backups/${filename}`
}

function buildHeaders(config: WebDavSyncConfig, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...(extra ?? {}) }
  if (config.username || config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString(
      'base64'
    )}`
  }
  return headers
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function extractXmlTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<[^>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tagName}>`, 'i')
  const match = xml.match(regex)
  return match ? decodeXml(match[1].trim()) : null
}

function extractHrefValues(xml: string): string[] {
  const values: string[] = []
  const regex = /<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml))) {
    values.push(decodeXml(match[1].trim()))
  }
  return values
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function webdavRequest(
  config: WebDavSyncConfig,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: buildHeaders(config, options.headers),
    body: options.body
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('WebDAV authentication failed')
  }
  return response
}

async function ensureCollection(config: WebDavSyncConfig, remotePath: string): Promise<void> {
  const parts = splitRemotePath(remotePath)
  for (let index = 1; index <= parts.length; index += 1) {
    const partial = parts.slice(0, index).join('/')
    const url = buildUrl(config.serverUrl, partial)
    const response = await webdavRequest(config, 'MKCOL', url)
    if ([200, 201, 204, 301, 302, 405].includes(response.status)) continue
    if (response.status === 409) continue
    throw new Error(`Failed to create WebDAV collection "${partial}": HTTP ${response.status}`)
  }
}

async function statFile(config: WebDavSyncConfig, url: string): Promise<RemoteFileStat> {
  const response = await webdavRequest(config, 'PROPFIND', url, {
    headers: {
      Depth: '0',
      'Content-Type': 'application/xml'
    },
    body: '<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><getetag/><getlastmodified/></prop></propfind>'
  })
  if (response.status === 404) {
    return { exists: false, etag: null, lastModified: null, updatedAt: null }
  }
  if (response.status !== 207 && response.status !== 200) {
    throw new Error(`WebDAV PROPFIND failed: HTTP ${response.status}`)
  }

  const text = await response.text()
  const lastModified = extractXmlTag(text, 'getlastmodified')
  const updatedAt = lastModified ? new Date(lastModified).getTime() : null
  return {
    exists: true,
    etag: extractXmlTag(text, 'getetag')?.replace(/^"|"$/g, '') ?? null,
    lastModified,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null
  }
}

function hasRemoteChanged(
  current: RemoteFileStat,
  previousExists?: boolean,
  previousEtag?: string | null,
  previousLastModified?: string | null
): boolean {
  if (previousExists === false && current.exists) return true
  if (previousExists === true && !current.exists) return true
  if (!current.exists) return Boolean(previousEtag || previousLastModified)
  if (previousEtag && current.etag && previousEtag !== current.etag) return true
  if (
    previousLastModified &&
    current.lastModified &&
    previousLastModified !== current.lastModified
  ) {
    return true
  }
  return false
}

async function listBackupHrefs(config: WebDavSyncConfig): Promise<string[]> {
  const backupsUrl = buildUrl(config.serverUrl, `${config.remoteDir}/backups`)
  const response = await webdavRequest(config, 'PROPFIND', backupsUrl, {
    headers: { Depth: '1' }
  })
  if (response.status === 404) return []
  if (response.status !== 207 && response.status !== 200) {
    throw new Error(`WebDAV backup list failed: HTTP ${response.status}`)
  }
  const xml = await response.text()
  return extractHrefValues(xml)
    .filter((href) => /state-\d{8}-\d{6}\.json\.gz$/i.test(href))
    .sort()
}

async function pruneBackups(config: WebDavSyncConfig): Promise<void> {
  const retention = Math.max(0, Math.floor(config.backupRetention))
  const hrefs = await listBackupHrefs(config)
  const overflow = hrefs.length - retention
  if (overflow <= 0) return
  for (const href of hrefs.slice(0, overflow)) {
    const url = href.startsWith('http')
      ? href
      : new URL(href, normalizeBaseUrl(config.serverUrl)).toString()
    const response = await webdavRequest(config, 'DELETE', url)
    if (![200, 202, 204, 404].includes(response.status)) {
      throw new Error(`Failed to delete old WebDAV backup: HTTP ${response.status}`)
    }
  }
}

export class WebDavProvider {
  async testConnection(config: WebDavSyncConfig): Promise<SyncConnectionTestResult> {
    try {
      normalizeBaseUrl(config.serverUrl)
      await ensureCollection(config, config.remoteDir || 'ola-sync/v1')
      await ensureCollection(config, `${config.remoteDir || 'ola-sync/v1'}/backups`)
      await statFile(config, buildCollectionUrl(config))
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async download(config: WebDavSyncConfig): Promise<RemoteBundleState> {
    await ensureCollection(config, config.remoteDir)
    await ensureCollection(config, `${config.remoteDir}/backups`)

    const stateUrl = buildStateUrl(config)
    const stat = await statFile(config, stateUrl)
    if (!stat.exists) {
      return {
        bundle: null,
        etag: null,
        lastModified: null,
        updatedAt: null
      }
    }

    const response = await webdavRequest(config, 'GET', stateUrl)
    if (response.status === 404) {
      return {
        bundle: null,
        etag: null,
        lastModified: null,
        updatedAt: null
      }
    }
    if (!response.ok) throw new Error(`WebDAV download failed: HTTP ${response.status}`)

    const buffer = ensureArrayBuffer(await response.arrayBuffer())
    const { gunzipSync } = await import('zlib')
    const bundle = JSON.parse(gunzipSync(buffer).toString('utf-8')) as SyncBundle
    return {
      bundle,
      etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? stat.etag,
      lastModified: response.headers.get('last-modified') ?? stat.lastModified,
      updatedAt: stat.updatedAt
    }
  }

  async upload(
    config: WebDavSyncConfig,
    bundle: SyncBundle,
    options: UploadRemoteBundleOptions = {}
  ): Promise<RemoteBundleState> {
    await ensureCollection(config, config.remoteDir)
    await ensureCollection(config, `${config.remoteDir}/backups`)

    const stateUrl = buildStateUrl(config)
    const current = await statFile(config, stateUrl)
    if (
      hasRemoteChanged(
        current,
        options.previousExists,
        options.previousEtag,
        options.previousLastModified
      )
    ) {
      throw new RemoteStateChangedError()
    }

    if (current.exists && config.backupRetention > 0) {
      const currentResponse = await webdavRequest(config, 'GET', stateUrl)
      if (currentResponse.ok) {
        const backupFilename = `state-${formatTimestamp()}.json.gz`
        const backupUrl = buildUrl(config.serverUrl, buildBackupPath(config, backupFilename))
        const body = ensureArrayBuffer(await currentResponse.arrayBuffer())
        const backupResponse = await webdavRequest(config, 'PUT', backupUrl, {
          headers: { 'Content-Type': 'application/gzip' },
          body: bufferToBody(body)
        })
        if (!backupResponse.ok) {
          throw new Error(`Failed to write WebDAV backup: HTTP ${backupResponse.status}`)
        }
      }
    }

    const { gzipSync } = await import('zlib')
    const body = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf-8'))
    const response = await webdavRequest(config, 'PUT', stateUrl, {
      headers: { 'Content-Type': 'application/gzip' },
      body: bufferToBody(body)
    })
    if (!response.ok) throw new Error(`WebDAV upload failed: HTTP ${response.status}`)

    await pruneBackups(config)
    return this.download(config)
  }
}

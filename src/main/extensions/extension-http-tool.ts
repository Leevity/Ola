import type {
  ExtensionFetchResponse,
  ExtensionManifest,
  ExtensionToolDefinition,
  ExtensionToolResult
} from '../../shared/extension-types'

const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 128 * 1024
const INTERPOLATION = /\{\{\s*(input|config)\.([A-Za-z0-9_.-]+)\s*\}\}/g

export type ExtensionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nestedValue(value: unknown, dottedPath: string): unknown {
  let current: unknown = value
  for (const part of dottedPath.split('.').filter(Boolean)) {
    const item = object(current)
    if (!item || !Object.hasOwn(item, part)) return undefined
    current = item[part]
  }
  return current
}

function replacement(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function interpolateExtensionValue(
  value: unknown,
  input: Record<string, unknown>,
  config: Record<string, string>
): unknown {
  if (typeof value === 'string') {
    return value.replace(INTERPOLATION, (_match, scope: string, key: string) =>
      replacement(scope === 'input' ? nestedValue(input, key) : config[key])
    )
  }
  if (Array.isArray(value))
    return value.map((item) => interpolateExtensionValue(item, input, config))
  const item = object(value)
  return item
    ? Object.fromEntries(
        Object.entries(item).map(([key, current]) => [
          key,
          interpolateExtensionValue(current, input, config)
        ])
      )
    : value
}

/** Checks an extension URL against its explicit http(s), host, port and path allowlist. */
export function isExtensionNetworkAllowed(
  manifest: ExtensionManifest,
  targetValue: string
): boolean {
  let target: URL
  try {
    target = new URL(targetValue)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    return false
  return (manifest.permissions?.network ?? []).some((permission) => {
    const raw = permission.trim()
    if (!raw || raw === '*') return false
    const wildcard = raw.endsWith('*')
    const value = wildcard ? raw.slice(0, -1) : raw
    let allowed: URL
    try {
      allowed = new URL(value)
    } catch {
      return false
    }
    if (
      !['http:', 'https:'].includes(allowed.protocol) ||
      allowed.username ||
      allowed.password ||
      target.protocol !== allowed.protocol ||
      target.hostname.toLowerCase() !== allowed.hostname.toLowerCase() ||
      target.port !== allowed.port
    )
      return false
    if (allowed.pathname === '/') return true
    return wildcard
      ? allowed.pathname.endsWith('/') && target.pathname.startsWith(allowed.pathname)
      : target.pathname === allowed.pathname
  })
}

function findHttpTool(manifest: ExtensionManifest, toolName: string): ExtensionToolDefinition {
  const tool = manifest.tools.find((candidate) => candidate.name === toolName)
  if (!tool) throw new Error('Tool "' + toolName + '" not found in extension "' + manifest.id + '"')
  if (tool.kind !== 'http' || !tool.http)
    throw new Error('Tool "' + toolName + '" is not an HTTP tool')
  return tool
}

function responseHeaders(response: Response): Record<string, string> {
  const sensitive = new Set(['authorization', 'proxy-authenticate', 'set-cookie', 'x-api-key'])
  return Object.fromEntries(
    [...response.headers.entries()]
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .filter(([key]) => !sensitive.has(key))
  )
}

function responseResult(response: Response, text: string): ExtensionFetchResponse {
  let json: unknown
  try {
    json = text.trim() ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
    text,
    ...(json === undefined ? {} : { json })
  }
}

async function readResponseText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
    throw new Error('Extension response exceeds size limit')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Extension response exceeds size limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

export async function executeExtensionHttpTool(args: {
  manifest: ExtensionManifest
  enabled: boolean
  config: Record<string, string>
  toolName: string
  input?: Record<string, unknown>
  fetch?: ExtensionFetch
  signal?: AbortSignal
}): Promise<ExtensionToolResult> {
  if (!args.enabled) throw new Error('Extension "' + args.manifest.id + '" is disabled')
  const tool = findHttpTool(args.manifest, args.toolName)
  const input = args.input ?? {}
  const definition = tool.http!
  let url = String(interpolateExtensionValue(definition.url, input, args.config))
  let method = definition.method.toUpperCase() || 'GET'
  const headers = Object.fromEntries(
    Object.entries(definition.headers ?? {}).map(([key, value]) => [
      key,
      String(interpolateExtensionValue(value, input, args.config))
    ])
  )
  const body =
    definition.body === undefined
      ? undefined
      : interpolateExtensionValue(definition.body, input, args.config)
  const fetcher = args.fetch ?? fetch
  let response: Response | undefined
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!isExtensionNetworkAllowed(args.manifest, url))
      throw new Error('Network access denied for ' + (url || '(empty url)'))
    const requestBody =
      body === undefined || method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body)
    if (
      requestBody &&
      typeof body !== 'string' &&
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    )
      headers['Content-Type'] = 'application/json'
    response = await fetcher(url, {
      method,
      headers,
      body: requestBody,
      redirect: 'manual',
      signal: args.signal
    })
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location'))
      break
    if (redirectCount === MAX_REDIRECTS) throw new Error('Extension fetch exceeded redirect limit')
    url = new URL(response.headers.get('location')!, url).toString()
    if (response.status === 303) {
      method = 'GET'
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type') delete headers[key]
      }
    }
  }
  if (!response) throw new Error('Extension fetch failed')
  const data = responseResult(response, await readResponseText(response))
  return {
    __olaExtensionResult: true,
    extensionId: args.manifest.id,
    toolName: tool.name,
    text: data.ok
      ? ('HTTP ' + data.status + ' ' + data.statusText).trim()
      : ('HTTP request failed: ' + data.status + ' ' + data.statusText).trim(),
    data: {
      ok: data.ok,
      status: data.status,
      statusText: data.statusText,
      headers: data.headers,
      body: data.json ?? data.text
    }
  }
}

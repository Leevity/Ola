import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import type { ToolContext } from '../../runtime/tools/tool-executor'
import type { McpRuntimeManager } from './mcp-runtime-tools'

type FileArtifact = {
  kind: 'file'
  transport: 'local'
  path: string
  operation: 'create'
  mediaType?: string
}
const extensions: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
}
function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

/** Resource contracts are files; arbitrary tool text is never interpreted as a path. */
export async function materializeMcpArtifacts(
  output: object,
  context: ToolContext,
  manager: McpRuntimeManager,
  serverId: string,
  managedDirectory?: string
): Promise<FileArtifact[]> {
  const executionRoot = context.run?.workingDirectory
  const destination = executionRoot ?? managedDirectory
  if (!destination) return []
  if (!executionRoot) await mkdir(destination, { recursive: true })
  const root = await realpath(destination)
  const result = output as Record<string, unknown>
  if (result.isError === true || !Array.isArray(result.content)) return []
  const artifacts: FileArtifact[] = []
  const queue: unknown[] = result.content.slice(0, 64)
  let fetched = 0
  let bytes = 0
  for (const block of queue) {
    context.signal.throwIfAborted()
    if (artifacts.length >= 16 || !block || typeof block !== 'object') continue
    const entry = block as Record<string, unknown>
    if (entry.type === 'resource_link' && typeof entry.uri === 'string') {
      let uri: URL
      try {
        uri = new URL(entry.uri)
      } catch {
        continue
      }
      if (uri.protocol === 'file:') {
        if (!executionRoot) continue
        let candidate: string
        try {
          candidate = fileURLToPath(uri)
        } catch {
          continue
        }
        try {
          const stat = await lstat(candidate)
          const resolved = await realpath(candidate)
          if (stat.isFile() && !stat.isSymbolicLink() && inside(root, resolved))
            artifacts.push({
              kind: 'file',
              transport: 'local',
              path: resolved,
              operation: 'create'
            })
        } catch {
          /* Missing or out-of-scope resources are not indexed. */
        }
      } else if (
        !['https:', 'http:'].includes(uri.protocol) &&
        manager.readResource &&
        fetched < 8
      ) {
        fetched++
        const response = (await manager.readResource(serverId, entry.uri)) as {
          contents?: unknown[]
        }
        if (Array.isArray(response?.contents))
          queue.push(
            ...response.contents.slice(0, 16).map((resource) => ({ type: 'resource', resource }))
          )
      }
      continue
    }
    if (!['resource', 'image', 'audio'].includes(String(entry.type))) continue
    const resource = entry.type === 'resource' ? entry.resource : entry
    if (!resource || typeof resource !== 'object') continue
    const value = resource as Record<string, unknown>
    const mime =
      typeof value.mimeType === 'string' ? value.mimeType.split(';')[0].trim() : 'text/plain'
    const extension = extensions[mime]
    if (!extension) continue
    let data: Buffer
    if (typeof value.text === 'string') data = Buffer.from(value.text)
    else {
      const encoded =
        value.blob ?? (['image', 'audio'].includes(String(entry.type)) ? value.data : undefined)
      if (
        typeof encoded !== 'string' ||
        encoded.length > 24 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        continue
      data = Buffer.from(encoded, 'base64')
    }
    bytes += data.length
    if (bytes > 16 * 1024 * 1024) throw new Error('MCP resource files exceed size limit')
    const directory = join(root, '.ola-results', 'mcp')
    await mkdir(directory, { recursive: true })
    if (!inside(root, await realpath(directory)))
      throw new Error('MCP result directory escaped execution root')
    const identity = createHash('sha256')
      .update(`${context.run.runId}:${context.toolCallId ?? ''}`)
      .digest('hex')
      .slice(0, 16)
    const file = join(directory, `${identity}-${randomUUID()}.${extension}`)
    context.signal.throwIfAborted()
    await writeFile(file, data, { flag: 'wx', mode: 0o600 })
    artifacts.push({
      kind: 'file',
      transport: 'local',
      path: file,
      operation: 'create',
      mediaType: mime
    })
  }
  context.signal.throwIfAborted()
  return artifacts.filter(
    (artifact, index) => artifacts.findIndex((item) => item.path === artifact.path) === index
  )
}

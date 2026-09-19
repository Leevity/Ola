import JSZip from 'jszip'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const TEMP_ROOT_NAME = 'ola-skills'
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024
const MAX_FILES = 128

export async function materializeSkillArchive(options: {
  temporaryDirectory: string
  slug: string
  bytes: Uint8Array
  isZip: boolean
}): Promise<{ tempPath: string; files: { path: string; content: string }[] }> {
  if (!/^[a-z0-9-]+$/i.test(options.slug)) throw new Error('Invalid skill slug')
  if (options.bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error('Skills marketplace archive is too large')
  const root = resolve(options.temporaryDirectory, TEMP_ROOT_NAME)
  const base = resolve(root, `download-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const target = resolve(base, options.slug)
  if (!target.startsWith(`${base}${sep}`)) throw new Error('Invalid skill archive target')
  await mkdir(target, { recursive: true })
  try {
    if (options.isZip) await extractZip(options.bytes, target)
    else await writeFile(join(target, 'SKILL.md'), options.bytes)
    const manifest = await findManifest(target)
    if (!manifest) throw new Error(`Downloaded skill ${options.slug} is missing SKILL.md`)
    return { tempPath: target, files: await collectTextFiles(target) }
  } catch (error) {
    await rm(base, { recursive: true, force: true })
    throw error
  }
}

export async function cleanupSkillTemporaryDirectory(
  temporaryDirectory: string,
  value: string
): Promise<boolean> {
  const root = resolve(temporaryDirectory, TEMP_ROOT_NAME)
  const path = resolve(value)
  if (!path.startsWith(`${root}${sep}`)) return false
  const [first] = relative(root, path).split(sep)
  if (!first || first === '..') return false
  await rm(join(root, first), { recursive: true, force: true })
  return true
}

async function extractZip(bytes: Uint8Array, target: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (!entries.length || entries.length > MAX_FILES)
    throw new Error('Skills marketplace archive has an invalid file count')
  let total = 0
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (!name || name.startsWith('/') || name.split('/').includes('..'))
      throw new Error('Skills marketplace archive contains an unsafe path')
    const destination = resolve(target, name)
    if (!destination.startsWith(`${target}${sep}`))
      throw new Error('Skills marketplace archive contains an unsafe path')
    const content = await entry.async('nodebuffer')
    total += content.byteLength
    if (total > MAX_EXTRACTED_BYTES)
      throw new Error('Skills marketplace archive expands beyond the allowed size')
    await mkdir(resolve(destination, '..'), { recursive: true })
    await writeFile(destination, content)
  }
}

async function findManifest(root: string): Promise<string | undefined> {
  const files = await collectPaths(root)
  return files
    .filter((path) => /(^|\/)skills?\.md$/i.test(relative(root, path).split(sep).join('/')))
    .sort()[0]
}

async function collectTextFiles(root: string): Promise<{ path: string; content: string }[]> {
  const paths = await collectPaths(root)
  const text = new Set([
    '.md',
    '.txt',
    '.py',
    '.js',
    '.ts',
    '.tsx',
    '.sh',
    '.json',
    '.yaml',
    '.yml'
  ])
  const result: { path: string; content: string }[] = []
  for (const path of paths) {
    if (!text.has(path.slice(path.lastIndexOf('.')).toLowerCase())) continue
    result.push({
      path: relative(root, path).split(sep).join('/'),
      content: await (await import('node:fs/promises')).readFile(path, 'utf8')
    })
  }
  return result
}

async function collectPaths(root: string): Promise<string[]> {
  const { readdir, lstat } = await import('node:fs/promises')
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) result.push(...(await collectPaths(path)))
    else if (info.isFile()) result.push(path)
  }
  return result
}

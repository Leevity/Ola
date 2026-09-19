import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { extractSkillDescription, validateSkillManifest } from './skill-catalog'

const CODE_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.ts',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.rb',
  '.pl'
])
const MAX_SCRIPT_BYTES = 512 * 1024

export interface SkillScanFile {
  name: string
  size: number
  type: string
}

export interface SkillRisk {
  severity: 'safe' | 'warning' | 'danger'
  category: string
  detail: string
  file: string
  line?: number
}

export interface SkillScanResult {
  name: string
  description: string
  files: SkillScanFile[]
  risks: SkillRisk[]
  skillMdContent: string
  scriptContents: { file: string; content: string }[]
}

const RISK_PATTERNS: Array<{
  regex: RegExp
  severity: SkillRisk['severity']
  category: string
  detail: string
}> = [
  { regex: /\brm\s+-rf\b/, severity: 'danger', category: 'shell', detail: 'rm -rf' },
  { regex: /\bdel\s+\/[fFsS]/, severity: 'danger', category: 'shell', detail: 'del /f' },
  { regex: /\bformat\s+[A-Z]:/i, severity: 'danger', category: 'shell', detail: 'format drive' },
  { regex: /\bmkfs\b/, severity: 'danger', category: 'shell', detail: 'mkfs' },
  { regex: /\bdd\s+if=/, severity: 'danger', category: 'shell', detail: 'dd' },
  { regex: /\beval\s*\(/, severity: 'danger', category: 'execution', detail: 'eval()' },
  { regex: /\bexec\s*\(/, severity: 'warning', category: 'execution', detail: 'exec()' },
  { regex: /\bsubprocess\b/, severity: 'warning', category: 'execution', detail: 'subprocess' },
  { regex: /\bos\.system\s*\(/, severity: 'danger', category: 'execution', detail: 'os.system()' },
  {
    regex: /\bchild_process\b/,
    severity: 'warning',
    category: 'execution',
    detail: 'child_process'
  },
  { regex: /\bos\.popen\s*\(/, severity: 'danger', category: 'execution', detail: 'os.popen()' },
  {
    regex: /\brequests\.(get|post|put|delete|patch)\s*\(/,
    severity: 'warning',
    category: 'network',
    detail: 'requests HTTP call'
  },
  { regex: /\burllib\b/, severity: 'warning', category: 'network', detail: 'urllib' },
  { regex: /\bfetch\s*\(/, severity: 'warning', category: 'network', detail: 'fetch()' },
  { regex: /\bcurl\s+/, severity: 'warning', category: 'network', detail: 'curl' },
  { regex: /\bwget\s+/, severity: 'warning', category: 'network', detail: 'wget' },
  { regex: /\bhttpx?\.\w+\s*\(/, severity: 'warning', category: 'network', detail: 'HTTP client' },
  {
    regex: /\b(api_key|apikey|api[-_]?secret)\b/i,
    severity: 'warning',
    category: 'credential',
    detail: 'API key reference'
  },
  {
    regex: /\b(password|passwd)\s*[=:]/i,
    severity: 'danger',
    category: 'credential',
    detail: 'password assignment'
  },
  {
    regex: /\b(access_token|auth_token|bearer)\b/i,
    severity: 'warning',
    category: 'credential',
    detail: 'token reference'
  },
  {
    regex: /\bshutil\.rmtree\s*\(/,
    severity: 'danger',
    category: 'filesystem',
    detail: 'shutil.rmtree()'
  },
  {
    regex: /\bos\.remove\s*\(/,
    severity: 'warning',
    category: 'filesystem',
    detail: 'os.remove()'
  },
  {
    regex: /\bfs\.(unlinkSync|rmSync)\s*\(/,
    severity: 'danger',
    category: 'filesystem',
    detail: 'fs delete'
  },
  {
    regex: /\bbase64\b.*\b(send|post|upload)\b/i,
    severity: 'danger',
    category: 'exfiltration',
    detail: 'base64 + send'
  }
]

export async function scanSkillDirectory(
  sourcePath: string
): Promise<SkillScanResult | { error: string }> {
  try {
    const root = resolve(sourcePath)
    if (!(await isDirectory(root))) return { error: 'Selected skill folder was not found' }
    const manifestPath = join(root, 'SKILL.md')
    if (!(await isRegularFile(manifestPath)))
      return { error: 'No SKILL.md found in the selected folder' }
    const skillMdContent = await readFile(manifestPath, 'utf8')
    const name = basename(root)
    const manifestError = validateSkillManifest(skillMdContent, name)
    if (manifestError) return { error: manifestError }

    const paths = await walkFiles(root)
    const files = await Promise.all(paths.map((path) => fileInfo(root, path)))
    const scriptContents = await Promise.all(
      paths
        .filter((path) => CODE_EXTENSIONS.has(extname(path).toLowerCase()))
        .map((path) => readScript(root, path))
    )
    const scripts = scriptContents.filter(
      (script): script is { file: string; content: string } => script !== null
    )
    return {
      name,
      description: extractSkillDescription(skillMdContent, name),
      files: files.sort((left, right) => left.name.localeCompare(right.name)),
      risks: analyzeRisks([{ file: 'SKILL.md', content: skillMdContent }, ...scripts]),
      skillMdContent,
      scriptContents: scripts
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function analyzeRisks(contents: Array<{ file: string; content: string }>): SkillRisk[] {
  const result: SkillRisk[] = []
  const seen = new Set<string>()
  for (const { file, content } of contents) {
    const lines = content.replace(/\r\n?/g, '\n').split('\n')
    for (const pattern of RISK_PATTERNS) {
      for (const [index, line] of lines.entries()) {
        if (!pattern.regex.test(line)) continue
        const key = `${file}\u0000${index}\u0000${pattern.category}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({
          severity: pattern.severity,
          category: pattern.category,
          detail: pattern.detail,
          file,
          line: index + 1
        })
      }
    }
  }
  return result
}

async function fileInfo(root: string, path: string): Promise<SkillScanFile> {
  const info = await stat(path)
  const extension = extname(path).toLowerCase()
  return {
    name: relative(root, path).split(sep).join('/'),
    size: info.size,
    type: extension || 'unknown'
  }
}

async function readScript(
  root: string,
  path: string
): Promise<{ file: string; content: string } | null> {
  const info = await stat(path)
  if (info.size > MAX_SCRIPT_BYTES) return null
  return { file: relative(root, path).split(sep).join('/'), content: await readFile(path, 'utf8') }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) files.push(...(await walkFiles(path)))
    else if (info.isFile()) files.push(path)
  }
  return files
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

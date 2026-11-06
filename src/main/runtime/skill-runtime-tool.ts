import { lstat, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { SkillCatalog } from '../user-content/skill-catalog'
import { olaExternalDataHome } from '../lib/ola-data-root'

const MAX_SKILL_INSTRUCTION_LENGTH = 128 * 1024
const REFERENCE_EXTENSIONS = new Set(['.md', '.txt', '.json'])

export interface ValidatedSkillInput {
  SkillName: string
  FileName?: string
}

function validateSkillInput(
  value: unknown,
  allowedNames: ReadonlySet<string>
): ValidatedSkillInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => key !== 'SkillName' && key !== 'FileName') ||
    typeof input.SkillName !== 'string' ||
    !allowedNames.has(input.SkillName)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (input.FileName === undefined) return { SkillName: input.SkillName }
  if (typeof input.FileName !== 'string' || !input.FileName.trim())
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const fileName = normalizeFileName(input.FileName)
  if (
    !fileName ||
    fileName.includes('\0') ||
    isAbsoluteStylePath(input.FileName) ||
    !hasReferenceExtension(fileName) ||
    fileName.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { SkillName: input.SkillName, FileName: fileName }
}

function isAbsoluteStylePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\')
}

function normalizeFileName(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function hasReferenceExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 && REFERENCE_EXTENSIONS.has(fileName.slice(dot).toLowerCase())
}

/**
 * Reads one validated file from the skill directory. The model-supplied name was
 * already schema-checked; membership in catalog.listFiles() is the authoritative
 * allowlist so no path is ever trusted from the caller.
 */
async function readSkillFile(
  catalog: SkillCatalog,
  name: string,
  fileName: string
): Promise<{ content: string }> {
  if (!hasReferenceExtension(fileName)) throw new RuntimeError('INVALID_TOOL_INPUT')
  const listed = await catalog.listFiles(name)
  if ('error' in listed) throw new RuntimeError('SKILL_NOT_FOUND')
  const entry = listed.files.find((file) => file.name === fileName)
  if (!entry) throw new RuntimeError('INVALID_TOOL_INPUT')
  if (entry.size > MAX_SKILL_INSTRUCTION_LENGTH) throw new RuntimeError('INVALID_TOOL_INPUT')
  const location = await catalog.resolvePath(name)
  if (!location.success || !location.path) throw new RuntimeError('SKILL_NOT_FOUND')
  const directory = resolve(location.path)
  const path = resolve(directory, fileName)
  if (!path.startsWith(`${directory}${sep}`)) throw new RuntimeError('INVALID_TOOL_INPUT')
  const info = await lstat(path).catch(() => undefined)
  if (!info || !info.isFile()) throw new RuntimeError('INVALID_TOOL_INPUT')
  const content = await readFile(path, 'utf8')
  if (content.length > MAX_SKILL_INSTRUCTION_LENGTH) throw new RuntimeError('INVALID_TOOL_INPUT')
  return { content }
}

/** Main-owned, read-only Skill access limited to the validated Ola SkillCatalog. */
export async function createSkillRuntimeTool(): Promise<ToolDefinition> {
  const catalog = new SkillCatalog({
    homeDirectory: olaExternalDataHome(),
    bundledDirectoryCandidates: []
  })
  const skills = await catalog.list()
  const allowedNames = new Set(skills.map((skill) => skill.name))
  const description = skills.length
    ? [
        'Load one installed skill and return its instructions as context. Use only for a clearly matching workflow.',
        'Optional FileName loads one additional file from the skill folder (one file per call, .md, .txt or .json, e.g. "references/setup.md"); omit FileName to load SKILL.md.',
        "When SKILL.md loads, the result also lists the skill's available files; pass those names as FileName to read reference guides on demand.",
        'Available skills:',
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
      ].join('\n')
    : 'Load an installed skill by name and return its instructions as context. No skills are currently installed.'

  return {
    name: 'Skill',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        SkillName: { type: 'string', enum: [...allowedNames] },
        FileName: {
          type: 'string',
          description:
            'Optional file inside the skill folder to load instead of SKILL.md (for example "references/native-and-artifacts.md"). Limited to .md, .txt and .json files that exist in the skill.'
        }
      },
      required: ['SkillName'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (input) => validateSkillInput(input, allowedNames),
    resources: async () => [],
    execute: async (input) => {
      const { SkillName, FileName } = input as ValidatedSkillInput
      if (FileName !== undefined) {
        const file = await readSkillFile(catalog, SkillName, FileName)
        return {
          skillName: SkillName,
          fileName: FileName,
          content: file.content.trim()
        }
      }
      const result = await catalog.load(SkillName)
      if ('error' in result) throw new RuntimeError('SKILL_NOT_FOUND')
      if (result.content.length > MAX_SKILL_INSTRUCTION_LENGTH)
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const listed = await catalog.listFiles(SkillName)
      return {
        skillName: SkillName,
        content: result.content.trim(),
        workingDirectory: result.workingDirectory,
        ...('files' in listed && listed.files.length > 0 ? { files: listed.files } : {})
      }
    }
  }
}

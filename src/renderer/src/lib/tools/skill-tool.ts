import type { ToolHandler } from './tool-types'
import { toolRegistry } from '../agent/tool-registry'
import { ipcClient } from '../ipc/ipc-client'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'

type SkillMeta = { name: string; description: string }

let registeredSkills: SkillMeta[] = []
let registeredSkillSignature = ''

export function getRegisteredSkills(): SkillMeta[] {
  return registeredSkills.slice()
}

function normalizeSkills(skills: SkillMeta[]): SkillMeta[] {
  return skills
    .map((skill) => ({
      name: String(skill.name ?? '').trim(),
      description: String(skill.description ?? '').trim()
    }))
    .filter((skill) => skill.name)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

function buildSkillSignature(skills: SkillMeta[]): string {
  return JSON.stringify(skills)
}

async function loadRegisteredSkills(): Promise<SkillMeta[] | null> {
  try {
    const result = await ipcClient.invoke('skills:list')
    return Array.isArray(result) ? (result as SkillMeta[]) : []
  } catch (err) {
    console.error('[Skills] Failed to load skills from IPC:', err)
    return null
  }
}

export async function refreshSkillTools(): Promise<void> {
  const nextSkills = await loadRegisteredSkills()
  if (!nextSkills) {
    if (!toolRegistry.has('Skill')) {
      toolRegistry.register(createSkillHandler())
    }
    return
  }

  const normalizedSkills = normalizeSkills(nextSkills)
  const nextSignature = buildSkillSignature(normalizedSkills)
  if (nextSignature === registeredSkillSignature && toolRegistry.has('Skill')) return

  registeredSkills = normalizedSkills
  registeredSkillSignature = nextSignature
  toolRegistry.register(createSkillHandler())
}

function buildSkillDescription(): string {
  const skillList =
    registeredSkills.length > 0
      ? [
          '',
          'Currently available skills:',
          ...registeredSkills.map((skill) => `- ${skill.name}: ${skill.description}`)
        ].join('\n')
      : '\n\nNo skills are currently installed.'

  return `Load a skill by name to get detailed instructions or domain knowledge for a specialized task. Returns the full content of the skill's SKILL.md file as context, plus a list of other files in the skill folder. Optional FileName loads one of those files instead of SKILL.md (one file per call, .md, .txt or .json, e.g. "references/setup.md").

You have access to **Skills** — curated guides for specific workflows.
Only use the Skill tool when the user's request clearly matches a listed skill, or when the user explicitly asks for a skill.
Do not call Skill for ordinary coding, file editing, searching, debugging, or repository navigation requests unless a listed skill is obviously the best fit.

### How to use Skills
1. **Match carefully**: Use a skill only when the request clearly aligns with one of the available skills in the session context.
2. **Load first when relevant**: If a listed skill is clearly applicable, call the Skill tool before other tools.
3. **Read carefully**: After loading, read the Skill's content thoroughly before taking any action.
4. **Follow strictly**: Execute the Skill's instructions step-by-step. Do NOT skip steps, reorder them, or substitute your own approach.
5. **Retry on failure**: If a Skill's script fails, fix the issue and re-run the same script command when appropriate.
6. If the user's message begins with "[Skill: <name>]", immediately call that Skill as your first action.
7. **Reference files**: When SKILL.md routes you to a file such as \`references/x.md\`, load it with the same SkillName and that path as FileName.${skillList}`
}

const MAX_SKILL_FILE_BYTES = 128 * 1024
const REFERENCE_EXTENSIONS = ['.md', '.txt', '.json']

type SkillFileInfo = { name: string; size: number; type: string }

/** Structural FileName checks; catalog membership remains the authoritative allowlist. */
function normalizeSkillFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return undefined
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(trimmed))
    return undefined
  const fileName = trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || !REFERENCE_EXTENSIONS.includes(fileName.slice(dot).toLowerCase()))
    return undefined
  if (fileName.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    return undefined
  return fileName
}

async function loadSkillFile(skillName: string, fileName: string): Promise<string> {
  const listed = (await ipcClient.invoke('skills:list-files', { name: skillName })) as {
    files?: SkillFileInfo[]
    error?: unknown
  }
  if (!Array.isArray(listed.files))
    throw new Error(typeof listed.error === 'string' ? listed.error : 'Skill file listing failed')
  const entry = listed.files.find((file) => file.name === fileName)
  if (!entry) throw new Error(`File "${fileName}" was not found in skill "${skillName}"`)
  if (entry.size > MAX_SKILL_FILE_BYTES)
    throw new Error(`File "${fileName}" exceeds the ${MAX_SKILL_FILE_BYTES} byte limit`)
  // Reuse skills:load for its workingDirectory (the validated skill folder); no
  // new IPC channel and no path is ever built from the model-supplied FileName.
  const location = (await ipcClient.invoke('skills:load', { name: skillName })) as {
    workingDirectory?: unknown
    error?: unknown
  }
  if (typeof location.workingDirectory !== 'string' || !location.workingDirectory.trim())
    throw new Error(
      typeof location.error === 'string' && location.error.trim()
        ? location.error
        : 'Skill directory could not be resolved'
    )
  const read = (await ipcClient.invoke('fs:read-file', {
    path: `${location.workingDirectory.replace(/[\\/]+$/, '')}/${fileName}`
  })) as unknown
  if (typeof read === 'string') return read
  if (read && typeof read === 'object' && 'content' in read && typeof read.content === 'string')
    return read.content
  throw new Error(
    read && typeof read === 'object' && 'error' in read
      ? String((read as { error?: unknown }).error)
      : 'Skill file read returned no content'
  )
}

function createSkillHandler(): ToolHandler {
  const availableSkillNames = registeredSkills.map((skill) => skill.name)

  return {
    definition: {
      name: 'Skill',
      description: buildSkillDescription(),
      inputSchema: {
        type: 'object',
        properties: {
          SkillName: {
            type: 'string',
            description: 'The name of the skill to load. Must match one of the available skills.',
            ...(availableSkillNames.length > 0 ? { enum: availableSkillNames } : {})
          },
          FileName: {
            type: 'string',
            description:
              'Optional file inside the skill folder to load instead of SKILL.md (for example "references/native-and-artifacts.md"). Limited to .md, .txt and .json files that exist in the skill.'
          }
        },
        required: ['SkillName']
      }
    },
    execute: async (input) => {
      const skillName = input.SkillName as string
      if (!skillName) {
        return encodeToolError('SkillName is required')
      }
      const fileName = normalizeSkillFileName(input.FileName)
      if (input.FileName !== undefined && input.FileName !== null && !fileName) {
        return encodeToolError(
          'FileName must be a relative path inside the skill folder with a .md, .txt or .json extension'
        )
      }
      try {
        if (fileName) {
          const content = await loadSkillFile(skillName, fileName)
          return encodeStructuredToolResult({
            skillName,
            fileName,
            content: content.trim()
          })
        }
        const result = await ipcClient.invoke('skills:load', { name: skillName })
        if (!result || typeof result !== 'object')
          return encodeToolError('Skill load returned no content')
        const record = result as { content?: unknown; workingDirectory?: unknown; error?: unknown }
        if (typeof record.error === 'string' && record.error.trim())
          return encodeToolError(record.error)
        if (typeof record.content !== 'string')
          return encodeToolError('Skill load returned no content')
        let files: SkillFileInfo[] | undefined
        try {
          const listed = (await ipcClient.invoke('skills:list-files', { name: skillName })) as {
            files?: SkillFileInfo[]
          }
          files = Array.isArray(listed?.files) ? listed.files : undefined
        } catch {
          files = undefined
        }
        return encodeStructuredToolResult({
          skillName,
          content: record.content,
          ...(typeof record.workingDirectory === 'string'
            ? { workingDirectory: record.workingDirectory }
            : {}),
          ...(files && files.length > 0 ? { files } : {})
        })
      } catch (error) {
        return encodeToolError(error instanceof Error ? error.message : String(error))
      }
    },
    requiresApproval: () => false
  }
}

/**
 * Load available skills from ~/agents/skills/ via IPC,
 * then register the Skill tool with a stable description.
 *
 * This is async because it reads skill metadata via IPC from the main process.
 * Similar pattern to registerBuiltinSubAgents().
 */
export async function registerSkillTools(): Promise<void> {
  await refreshSkillTools()
}

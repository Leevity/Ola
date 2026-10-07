import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { SkillCatalog } from '../user-content/skill-catalog'
import { olaExternalDataHome } from '../lib/ola-data-root'

const MAX_SKILL_INSTRUCTION_LENGTH = 128 * 1024

function validateSkillInput(
  value: unknown,
  allowedNames: ReadonlySet<string>
): { SkillName: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => key !== 'SkillName') ||
    typeof input.SkillName !== 'string' ||
    !allowedNames.has(input.SkillName)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { SkillName: input.SkillName }
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
        SkillName: { type: 'string', enum: [...allowedNames] }
      },
      required: ['SkillName'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (input) => validateSkillInput(input, allowedNames),
    resources: async () => [],
    execute: async (input) => {
      const name = (input as { SkillName: string }).SkillName
      const result = await catalog.load(name)
      if ('error' in result) throw new RuntimeError('SKILL_NOT_FOUND')
      if (result.content.length > MAX_SKILL_INSTRUCTION_LENGTH)
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        skillName: name,
        content: result.content.trim(),
        workingDirectory: result.workingDirectory
      }
    }
  }
}

export type ScenarioPolicy = 'project-read-only' | 'ssh-read-only' | 'materials-no-tools'

const PROJECT_READ_TOOLS = new Set([
  'Read',
  'LS',
  'Glob',
  'Grep',
  'read_text_file',
  'list_directory',
  'find_files',
  'glob_files'
])

const SSH_READ_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep'])

export function scenarioAllowsTool(policy: ScenarioPolicy, name: string): boolean {
  if (policy === 'materials-no-tools') return false
  return (policy === 'project-read-only' ? PROJECT_READ_TOOLS : SSH_READ_TOOLS).has(name)
}

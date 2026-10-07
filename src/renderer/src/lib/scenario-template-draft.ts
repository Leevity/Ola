export interface ScenarioTemplateDraft {
  scope: string
  materials: string
}

// Temporary form recovery only; user materials are never written to localStorage.
const drafts = new Map<string, ScenarioTemplateDraft>()

export function scenarioTemplateDraftKey(
  workspaceId: string,
  scenarioId: string,
  version: number
): string {
  return JSON.stringify([workspaceId, scenarioId, version])
}

export function readScenarioTemplateDraft(key: string): ScenarioTemplateDraft | null {
  const draft = drafts.get(key)
  return draft ? { ...draft } : null
}

export function saveScenarioTemplateDraft(key: string, draft: ScenarioTemplateDraft): void {
  drafts.delete(key)
  drafts.set(key, { ...draft })
  if (drafts.size > 32) drafts.delete(drafts.keys().next().value!)
}

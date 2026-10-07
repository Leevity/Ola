import { describe, expect, it } from 'vitest'
import {
  readScenarioTemplateDraft,
  saveScenarioTemplateDraft,
  scenarioTemplateDraftKey
} from '../../src/renderer/src/lib/scenario-template-draft'

describe('temporary scenario recovery', () => {
  it('retains unsent parameters for repair navigation, isolated by space, scenario and version', () => {
    const key = scenarioTemplateDraftKey('team-a', 'report', 1)
    const original = { scope: 'Quarterly report', materials: 'User materials' }
    saveScenarioTemplateDraft(key, original)
    original.materials = 'changed elsewhere'
    expect(readScenarioTemplateDraft(key)?.materials).toBe('User materials')
    expect(readScenarioTemplateDraft(scenarioTemplateDraftKey('team-b', 'report', 1))).toBeNull()
    expect(readScenarioTemplateDraft(scenarioTemplateDraftKey('team-a', 'review', 1))).toBeNull()
    expect(readScenarioTemplateDraft(scenarioTemplateDraftKey('team-a', 'report', 2))).toBeNull()
  })
})

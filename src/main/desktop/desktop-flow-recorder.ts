import { randomUUID } from 'crypto'
import type {
  DesktopFlow,
  DesktopFlowRecordingStatus,
  DesktopFlowRiskLevel,
  DesktopFlowStep,
  DesktopFlowStepType
} from '../../shared/desktop-flow'

let activeFlow: DesktopFlow | null = null
let activeOwnerId: number | null = null
let paused = false
let captureText = false

function defaultRisk(type: DesktopFlowStepType): DesktopFlowRiskLevel {
  if (type === 'type' || type === 'keypress') return 'medium'
  if (type === 'click' || type === 'double_click') return 'medium'
  return 'low'
}

export function startDesktopFlowRecording(
  name = 'Untitled desktop flow',
  options: { captureText?: boolean; workspaceId?: string; ownerId?: number } = {}
): DesktopFlow {
  if (activeFlow) throw new Error('DESKTOP_FLOW_RECORDING_ACTIVE')
  activeFlow = {
    id: randomUUID(),
    workspaceId: options.workspaceId ?? 'local-personal',
    name: name.trim().slice(0, 160) || 'Untitled desktop flow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: []
  }
  paused = false
  activeOwnerId = options.ownerId ?? null
  // Typed text commonly contains passwords, API keys, and personal data. It is
  // intentionally never captured into a persistent flow in the secure runtime.
  void options
  captureText = false
  return structuredClone(activeFlow)
}

export function setDesktopFlowRecordingPaused(value: boolean): DesktopFlowRecordingStatus {
  paused = value
  return getDesktopFlowRecordingStatus()
}

export function stopDesktopFlowRecording(): DesktopFlow | null {
  const result = activeFlow ? structuredClone(activeFlow) : null
  activeFlow = null
  activeOwnerId = null
  paused = false
  captureText = false
  return result
}

export function getDesktopFlowRecordingStatus(): DesktopFlowRecordingStatus {
  return {
    recording: activeFlow !== null,
    paused,
    captureText,
    flowId: activeFlow?.id ?? null,
    stepCount: activeFlow?.steps.length ?? 0
  }
}

export function getActiveDesktopFlow(): DesktopFlow | null {
  return activeFlow ? structuredClone(activeFlow) : null
}

export function getDesktopFlowRecordingOwnerId(): number | null {
  return activeOwnerId
}

export function recordDesktopFlowStep(
  input: Omit<DesktopFlowStep, 'id' | 'createdAt' | 'riskLevel'> & {
    riskLevel?: DesktopFlowRiskLevel
  },
  ownerId?: number
): void {
  if (!activeFlow || paused || activeOwnerId === null || ownerId !== activeOwnerId) return
  const safeInput =
    input.type === 'type'
      ? {
          ...input,
          text: undefined,
          expectedChange: input.expectedChange ?? 'Text input omitted for safety.'
        }
      : input
  const step: DesktopFlowStep = {
    ...safeInput,
    id: randomUUID(),
    createdAt: Date.now(),
    riskLevel: safeInput.riskLevel ?? defaultRisk(safeInput.type)
  }
  activeFlow.steps.push(step)
  if (step.type === 'type') activeFlow.requiresReview = true
  activeFlow.updatedAt = Date.now()
}

export function updateActiveDesktopFlow(flow: DesktopFlow): DesktopFlow | null {
  if (!activeFlow || activeFlow.id !== flow.id || activeFlow.workspaceId !== flow.workspaceId)
    return null
  activeFlow = structuredClone(flow)
  activeFlow.updatedAt = Date.now()
  return structuredClone(activeFlow)
}

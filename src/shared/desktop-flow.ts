export type DesktopFlowStepType =
  | 'screenshot'
  | 'click'
  | 'double_click'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'drag'
  | 'wait'
  | 'assert'

export type DesktopFlowRiskLevel = 'low' | 'medium' | 'high'

export interface DesktopFlowStep {
  id: string
  type: DesktopFlowStepType
  createdAt: number
  windowTitle?: string
  processName?: string
  screenshotBefore?: string
  screenshotAfter?: string
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
  text?: string
  key?: string
  keys?: string[]
  scrollX?: number
  scrollY?: number
  expectedChange?: string
  riskLevel: DesktopFlowRiskLevel
}

export interface DesktopFlow {
  id: string
  /** Absent only on pre-workspace local-personal recordings. */
  workspaceId?: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
  steps: DesktopFlowStep[]
  /** Legacy flows that contained captured text must be recreated before replay. */
  requiresReview?: boolean
}

export interface DesktopFlowRecordingStatus {
  recording: boolean
  paused: boolean
  captureText: boolean
  flowId?: string | null
  stepCount: number
}

export interface DesktopActionReceipt {
  stepId: string
  success: boolean
  beforeHash?: string | null
  afterHash?: string | null
  changed?: boolean
  error?: string
}

export interface DesktopFlowReplayResult {
  success: boolean
  error?: string
  receipts?: DesktopActionReceipt[]
}

export interface DesktopFlowRun {
  id: string
  flowId: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  errorMessage: string | null
  startedAt: number
  finishedAt: number | null
}

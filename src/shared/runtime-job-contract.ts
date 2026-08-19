export const RUNTIME_JOB_ROUTES = {
  submit: 'runtime/jobs-submit',
  get: 'runtime/jobs-get',
  list: 'runtime/jobs-list',
  setState: 'runtime/jobs-state',
  cancel: 'runtime/jobs-cancel'
} as const

export type RuntimeJobState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface RuntimeJobRecord {
  jobId: string
  runId?: string | null
  sessionId?: string | null
  method: string
  state: RuntimeJobState
  idempotencyKey?: string | null
  laneKey?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: number
  updatedAt: number
  finishedAt?: number | null
}

export interface RuntimeJobMutationResult {
  accepted: boolean
  duplicate: boolean
  job?: RuntimeJobRecord | null
}

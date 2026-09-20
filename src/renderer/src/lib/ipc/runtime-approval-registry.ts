import type { RuntimeApprovalRequest } from './runtime-approval-protocol'

export interface RuntimeApprovalDecision {
  approved: boolean
  reason?: string
}

export type RuntimeApprovalHandler = (
  request: RuntimeApprovalRequest
) =>
  | Promise<RuntimeApprovalDecision | null | undefined>
  | RuntimeApprovalDecision
  | null
  | undefined

const runApprovalHandlers = new Map<string, RuntimeApprovalHandler>()

export function registerRuntimeApprovalHandler(
  runId: string,
  handler: RuntimeApprovalHandler
): () => void {
  runApprovalHandlers.set(runId, handler)
  return () => {
    if (runApprovalHandlers.get(runId) === handler) {
      runApprovalHandlers.delete(runId)
    }
  }
}

export async function resolveRuntimeApprovalRequest(
  request: RuntimeApprovalRequest
): Promise<RuntimeApprovalDecision | null> {
  if (!request.runId) return null

  const handler = runApprovalHandlers.get(request.runId)
  if (!handler) return null

  return (await handler(request)) ?? null
}

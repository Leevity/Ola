import { RuntimeError } from '../../shared/runtime/contracts'
import type { ManagedModelTarget } from '../../runtime/providers/transport'

export function resolveManagedResourceTarget(input: {
  workspaceId: string
  resourceId: string
  resources: unknown[]
}): ManagedModelTarget {
  const resource = input.resources.find(
    (value) =>
      !!value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).id === input.resourceId &&
      (value as Record<string, unknown>).enabled === true
  ) as Record<string, unknown> | undefined
  if (
    !resource ||
    (resource.protocol !== 'openai-chat' && resource.protocol !== 'openai-responses') ||
    typeof resource.model !== 'string' ||
    !resource.model
  )
    throw new RuntimeError('MODEL_UNAVAILABLE')
  return {
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    protocol: resource.protocol,
    model: resource.model
  }
}

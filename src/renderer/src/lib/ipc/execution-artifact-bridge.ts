import type {
  ExecutionArtifactCategory,
  ExecutionArtifactPage
} from '../../../../shared/execution-artifact'
import { invokeMessagePackBinary } from './messagepack-ipc-client'

export async function listExecutionArtifacts(input: {
  workspaceId: string
  projectId?: string
  runId?: string
  query?: string
  category?: ExecutionArtifactCategory
  createdAfter?: number
  offset?: number
  limit?: number
}): Promise<ExecutionArtifactPage> {
  const result = await invokeMessagePackBinary<ExecutionArtifactPage & { error?: string }>(
    'execution-artifacts:list:msgpack',
    input
  )
  if (result.error) throw new Error(result.error)
  return {
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    nextOffset: typeof result.nextOffset === 'number' ? result.nextOffset : null
  }
}

export async function hideExecutionArtifact(input: {
  workspaceId: string
  runId: string
  seq: number
}): Promise<void> {
  const result = await invokeMessagePackBinary<{ hidden?: boolean; error?: string }>(
    'execution-artifacts:hide:msgpack',
    input
  )
  if (result.error) throw new Error(result.error)
  if (result.hidden !== true) throw new Error('ARTIFACT_HIDE_FAILED')
}

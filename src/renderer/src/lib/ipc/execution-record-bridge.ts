import type { ExecutionRecord } from '../../../../shared/execution-record'
import { invokeMessagePackBinary } from './messagepack-ipc-client'

export async function listExecutionRecords(workspaceId: string): Promise<ExecutionRecord[]> {
  const result = await invokeMessagePackBinary<{
    records?: ExecutionRecord[]
    error?: string
  }>('execution-records:list:msgpack', { workspaceId })
  if (result.error) throw new Error(result.error)
  return Array.isArray(result.records) ? result.records : []
}

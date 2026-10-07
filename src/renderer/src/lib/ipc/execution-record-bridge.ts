import type { ExecutionRecord, ExecutionRecordCursor } from '../../../../shared/execution-record'
import { invokeMessagePackBinary } from './messagepack-ipc-client'

export type { ExecutionRecordCursor } from '../../../../shared/execution-record'

export async function listExecutionRecords(
  workspaceId: string,
  cursor?: ExecutionRecordCursor,
  filter: 'all' | 'attention' = 'all'
): Promise<{ records: ExecutionRecord[]; nextCursor: ExecutionRecordCursor | null }> {
  const result = await invokeMessagePackBinary<{
    records?: ExecutionRecord[]
    nextCursor?: ExecutionRecordCursor | null
    error?: string
  }>('execution-records:list:msgpack', { workspaceId, filter, ...(cursor ? { cursor } : {}) })
  if (result.error) throw new Error(result.error)
  return {
    records: Array.isArray(result.records) ? result.records : [],
    nextCursor: result.nextCursor ?? null
  }
}

import { getRequestTraceInfo } from '../debug-store'

export async function readRuntimeDebugBody(bodyRef: string): Promise<string> {
  const ref = bodyRef.trim()
  if (!ref || ref.length > 256) throw new Error('INVALID_DEBUG_BODY_REF')
  const trace = getRequestTraceInfo(ref)?.debugInfo
  const body = trace?.body ?? trace?.contextWindowBody
  if (typeof body === 'string') return body
  if (ref.startsWith('data:text/plain,')) {
    return decodeURIComponent(ref.slice('data:text/plain,'.length))
  }
  throw new Error('TS_RUNTIME_DEBUG_BODY_NOT_FOUND')
}

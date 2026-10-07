import type { StateStorage } from 'zustand/middleware'
import type { IPCChannel } from '../../../../shared/ipc/contract'
import { ipcClient } from './ipc-client'

type IpcStateStorageOptions = {
  getChannel: IPCChannel
  setChannel: IPCChannel
  mergeStateName?: string
  onWriteStatus?: (event: { name: string; status: 'saving' | 'saved' | 'failed' }) => void
}

function serializeStorageValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function parseStorageValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

type NestedStateValue = { path: string[]; value: unknown }

function collectStateChanges(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string[],
  patch: {
    set: Record<string, unknown>
    remove: string[]
    setPaths: NestedStateValue[]
    removePaths: string[][]
  }
): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const nextPath = [...path, key]
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      if (path.length) patch.removePaths.push(nextPath)
      else patch.remove.push(key)
      continue
    }
    if (
      nextPath.length < 16 &&
      Object.prototype.hasOwnProperty.call(previous, key) &&
      isRecord(previous[key]) &&
      isRecord(next[key])
    ) {
      collectStateChanges(previous[key], next[key], nextPath, patch)
    } else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      if (path.length) patch.setPaths.push({ path: nextPath, value: next[key] })
      else patch.set[key] = next[key]
    }
  }
}

function statePatch(
  previous: string | undefined,
  next: string
): {
  set: Record<string, unknown>
  remove: string[]
  setPaths: NestedStateValue[]
  removePaths: string[][]
  version: number | undefined
} | null {
  const previousValue = previous === undefined ? null : parseStorageValue(previous)
  const nextValue = parseStorageValue(next)
  if (
    !nextValue ||
    typeof nextValue !== 'object' ||
    !('state' in nextValue) ||
    !nextValue.state ||
    typeof nextValue.state !== 'object' ||
    Array.isArray(nextValue.state)
  )
    return null
  const previousState =
    previousValue &&
    typeof previousValue === 'object' &&
    'state' in previousValue &&
    previousValue.state &&
    typeof previousValue.state === 'object' &&
    !Array.isArray(previousValue.state)
      ? (previousValue.state as Record<string, unknown>)
      : {}
  const nextState = nextValue.state as Record<string, unknown>
  const patch = {
    set: {} as Record<string, unknown>,
    remove: [] as string[],
    setPaths: [] as NestedStateValue[],
    removePaths: [] as string[][]
  }
  collectStateChanges(previousState, nextState, [], patch)
  const version = 'version' in nextValue ? nextValue.version : undefined
  return { ...patch, version: typeof version === 'number' ? version : undefined }
}

export function createIpcStateStorage({
  getChannel,
  setChannel,
  mergeStateName,
  onWriteStatus
}: IpcStateStorageOptions): StateStorage {
  // Zustand persist calls setItem after every store mutation, even when
  // partialized data is unchanged. Keep that churn at the renderer boundary.
  const serializedValueCache = new Map<string, string>()
  const committedValueCache = new Map<string, string>()
  const writeQueues = new Map<string, Promise<void>>()
  const emitWriteStatus = (name: string, status: 'saving' | 'saved' | 'failed'): void => {
    try {
      onWriteStatus?.({ name, status })
    } catch {
      // A UI observer must not interrupt persistence.
    }
  }

  const enqueueWrite = (name: string, task: () => Promise<void>): Promise<void> => {
    const previous = writeQueues.get(name) ?? Promise.resolve()
    const queued = previous.catch(() => {}).then(task)
    const tracked = queued.finally(() => {
      if (writeQueues.get(name) === tracked) {
        writeQueues.delete(name)
      }
    })
    writeQueues.set(name, tracked)
    return tracked
  }

  return {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const value = await ipcClient.invoke(getChannel, name)
        const serialized = serializeStorageValue(value)
        if (serialized === null) {
          serializedValueCache.delete(name)
          committedValueCache.delete(name)
          return null
        }
        serializedValueCache.set(name, serialized)
        committedValueCache.set(name, serialized)
        return serialized
      } catch {
        return null
      }
    },

    setItem: async (name: string, value: string): Promise<void> => {
      if (serializedValueCache.get(name) === value) return

      serializedValueCache.set(name, value)
      const parsed = parseStorageValue(value)
      emitWriteStatus(name, 'saving')

      try {
        await enqueueWrite(name, async () => {
          const patch =
            name === mergeStateName ? statePatch(committedValueCache.get(name), value) : null
          const result = await ipcClient.invoke(
            setChannel,
            patch ? { key: name, patch } : { key: name, value: parsed }
          )
          if (
            result &&
            typeof result === 'object' &&
            'success' in result &&
            result.success === false
          )
            throw new Error('IPC_STATE_STORAGE_WRITE_FAILED')
          committedValueCache.set(name, value)
        })
        if (serializedValueCache.get(name) === value) emitWriteStatus(name, 'saved')
      } catch {
        if (serializedValueCache.get(name) === value) {
          serializedValueCache.delete(name)
          emitWriteStatus(name, 'failed')
        }
      }
    },

    removeItem: async (name: string): Promise<void> => {
      serializedValueCache.delete(name)
      emitWriteStatus(name, 'saving')
      try {
        await enqueueWrite(name, async () => {
          const result = await ipcClient.invoke(setChannel, { key: name, value: undefined })
          if (
            result &&
            typeof result === 'object' &&
            'success' in result &&
            result.success === false
          )
            throw new Error('IPC_STATE_STORAGE_WRITE_FAILED')
          committedValueCache.delete(name)
        })
        if (!serializedValueCache.has(name)) emitWriteStatus(name, 'saved')
      } catch {
        if (!serializedValueCache.has(name)) emitWriteStatus(name, 'failed')
      }
    }
  }
}

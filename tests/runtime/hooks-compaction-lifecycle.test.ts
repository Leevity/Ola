import { expect, it } from 'vitest'
import type { HookEvent, HookOutput } from '../../src/shared/hooks/types'
import type { UnifiedMessage } from '../../src/renderer/src/lib/api/types'
import {
  runPostCompactHooks,
  runPreCompactHooks,
  type CompactHookEmitter
} from '../../src/renderer/src/lib/agent/compaction-hooks'

function summaryMessage(summary: string): UnifiedMessage {
  return {
    id: 'summary',
    role: 'user',
    content: summary,
    createdAt: 1,
    meta: { compactSummary: { messagesSummarized: 3, recentMessagesPreserved: true } }
  }
}

function emitter(outputs: Partial<HookOutput>[]): {
  calls: Array<{ event: HookEvent; invocation: Parameters<CompactHookEmitter>[1] }>
  emit: CompactHookEmitter
} {
  const calls: Array<{ event: HookEvent; invocation: Parameters<CompactHookEmitter>[1] }> = []
  return {
    calls,
    emit: async (event, invocation) => {
      calls.push({ event, invocation })
      return outputs as HookOutput[]
    }
  }
}

const subject = { sessionId: 'session-a', projectPath: '/project', trigger: 'manual' as const }

it('stops a compaction that preCompact blocks', async () => {
  const hook = emitter([{ block: { reason: 'context is evidence' } }])
  const decision = await runPreCompactHooks(hook.emit, subject, [])
  expect(decision).toEqual({ blocked: 'context is evidence' })
  expect(hook.calls[0].event).toBe('preCompact')
  expect(hook.calls[0].invocation.projectPath).toBe('/project')
})

it('steers the summary with preCompact additional context', async () => {
  const hook = emitter([{ additionalContext: 'keep the migration checklist' }])
  const decision = await runPreCompactHooks(hook.emit, subject, [])
  expect(decision).toEqual({ blocked: null, focusPrompt: 'keep the migration checklist' })
})

it('fails open when the preCompact emitter throws', async () => {
  const decision = await runPreCompactHooks(
    async () => {
      throw new Error('timed-out')
    },
    subject,
    []
  )
  expect(decision).toEqual({ blocked: null })
})

it('appends postCompact context to the stored summary message', async () => {
  const hook = emitter([{ additionalContext: 'policy note' }])
  const messages: UnifiedMessage[] = [
    summaryMessage('# Summary'),
    { id: 'tail', role: 'user', content: 'hi', createdAt: 2 }
  ]
  const next = await runPostCompactHooks(hook.emit, subject, messages)
  expect(next[0].content).toBe('# Summary\n\npolicy note')
  expect(next[1]).toEqual(messages[1])
  expect(hook.calls[0].event).toBe('postCompact')
})

it('leaves the transcript untouched when postCompact returns nothing', async () => {
  const messages = [summaryMessage('# Summary')]
  const next = await runPostCompactHooks(emitter([]).emit, subject, messages)
  expect(next).toBe(messages)
})

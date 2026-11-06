import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCronRun: vi.fn(async () => undefined),
  updateCronRun: vi.fn(async () => undefined),
  appendCronRunLog: vi.fn(async () => undefined),
  getCronRun: vi.fn(async () => null),
  getCronJob: vi.fn(async () => null),
  recordCronDelivery: vi.fn(async () => undefined),
  replaceCronRunMessages: vi.fn(async () => undefined),
  canary: vi.fn(() => null),
  sendEvent: vi.fn(),
  deliver: vi.fn(async () => undefined),
  definition: vi.fn(async () => null),
  submit: vi.fn(async () => {
    throw new Error('RUN MUST NOT BE SUBMITTED')
  })
}))

vi.mock('../../src/main/db/cron-dao', () => ({
  createCronRun: mocks.createCronRun,
  updateCronRun: mocks.updateCronRun,
  appendCronRunLog: mocks.appendCronRunLog,
  getCronRun: mocks.getCronRun,
  getCronJob: mocks.getCronJob,
  recordCronDelivery: mocks.recordCronDelivery,
  replaceCronRunMessages: mocks.replaceCronRunMessages
}))
vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: mocks.canary
}))
vi.mock('../../src/main/cron/cron-workspace-events', () => ({
  sendCronWorkspaceEvent: mocks.sendEvent
}))
vi.mock('../../src/main/cron/cron-session-delivery', () => ({
  deliverCronSessionResult: mocks.deliver
}))
vi.mock('../../src/main/cron/cron-delivery-tracking', () => ({
  classifyCronDeliveryResult: vi.fn(() => null)
}))
vi.mock('../../src/main/cron/cron-agent-definition', () => ({
  resolveCronAgentDefinition: mocks.definition
}))
vi.mock('../../src/main/runtime/run-stream-consumer', () => ({
  openMainRunStream: vi.fn()
}))
vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: { request: mocks.submit }
}))

import {
  abortTsCronAgentRun,
  createTsCronRunSpec,
  runTsCronAgentInBackground
} from '../../src/main/cron/ts-cron-agent-background'

const unbound = {
  jobId: 'job-unbound',
  name: 'Nightly report',
  prompt: 'Summarize yesterday',
  workspaceId: 'team-a',
  deliveryMode: 'desktop',
  runKind: 'scheduled' as const,
  modelSource: null
}

describe('cron run without a model binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canary.mockReturnValue(null)
  })

  it('persists and broadcasts a failed run instead of rejecting in the background', async () => {
    const escaped = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const finished = vi.fn()
    try {
      runTsCronAgentInBackground(unbound, finished)
      await vi.waitFor(() => {
        expect(mocks.updateCronRun).toHaveBeenCalled()
        expect(mocks.sendEvent).toHaveBeenCalledWith(
          'team-a',
          'cron:run-finished',
          expect.objectContaining({ status: 'error', error: 'MODEL_NOT_SELECTED' })
        )
      })
      expect(finished).toHaveBeenCalledWith('job-unbound')
      expect(mocks.createCronRun).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-unbound', workspaceId: 'team-a' })
      )
      expect(mocks.updateCronRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'team-a',
          patch: expect.objectContaining({ status: 'error', error: 'MODEL_NOT_SELECTED' })
        })
      )
      expect(mocks.submit).not.toHaveBeenCalled()
      expect(abortTsCronAgentRun('job-unbound')).toBe(false)
      expect(
        escaped.mock.calls.filter((call) => String(call[0]).includes('outside its own reporting'))
      ).toEqual([])
    } finally {
      escaped.mockRestore()
    }
  })

  it('reports the failure on the personal workspace when the job has no scope of its own', async () => {
    runTsCronAgentInBackground({ ...unbound, jobId: 'job-unbound-no-scope', workspaceId: null })
    await vi.waitFor(() => {
      expect(mocks.sendEvent).toHaveBeenCalledWith(
        'local-personal',
        'cron:run-finished',
        expect.objectContaining({ error: 'MODEL_NOT_SELECTED' })
      )
    })
    expect(mocks.updateCronRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: 'local-personal' })
    )
  })

  it('still refuses to build a runtime request without a model binding', () => {
    expect(() =>
      createTsCronRunSpec({ ...unbound, jobId: 'job-unbound-spec' }, 'run-spec')
    ).toThrow('MODEL_NOT_SELECTED')
  })
})

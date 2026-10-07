import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()

vi.mock('../../src/main/db/business-write-canary', () => ({
  getTsDatabaseRouteGuard: () => ({ request })
}))

import { getCronRunDetail, listCronRuns } from '../../src/main/db/cron-dao'

const runDetail = {
  id: 'cron-run-1',
  job_id: 'job-1',
  started_at: 10,
  finished_at: 20,
  status: 'success' as const,
  tool_call_count: 0,
  output_summary: null,
  error: null,
  scheduled_for: null,
  job_name_snapshot: 'Cron task',
  prompt_snapshot: 'Run the task',
  source_session_id_snapshot: null,
  source_session_title_snapshot: null,
  source_project_id_snapshot: null,
  source_project_name_snapshot: null,
  source_provider_id_snapshot: null,
  model_snapshot: null,
  model_source_snapshot: null,
  working_folder_snapshot: null,
  delivery_mode_snapshot: 'none',
  delivery_target_snapshot: null
}

describe('listCronRuns', () => {
  beforeEach(() => {
    request.mockReset()
  })

  it('accepts rows returned directly by the TS BusinessRepository', async () => {
    const rows = [{ id: 'cron-run-1', job_id: 'job-1', started_at: 10 }]
    request.mockResolvedValue(rows)

    await expect(listCronRuns({ workspaceId: 'workspace-1' })).resolves.toBe(rows)
    expect(request).toHaveBeenCalledWith(
      'db/cron-runs-list',
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      120_000
    )
  })

  it('continues to unwrap the legacy Native response envelope', async () => {
    const rows = [{ id: 'cron-run-2', job_id: 'job-2', started_at: 20 }]
    request.mockResolvedValue({ success: true, runs: rows })

    await expect(listCronRuns({ workspaceId: 'workspace-1' })).resolves.toEqual(rows)
  })

  it('preserves errors returned by the legacy Native response envelope', async () => {
    request.mockResolvedValue({ success: false, runs: [], error: 'storage unavailable' })

    await expect(listCronRuns({ workspaceId: 'workspace-1' })).rejects.toThrow(
      'storage unavailable'
    )
  })
})

describe('getCronRunDetail', () => {
  beforeEach(() => {
    request.mockReset()
  })

  it('accepts the TS BusinessRepository detail object including delivery rows', async () => {
    const detail = {
      run: runDetail,
      job: null,
      messages: [],
      logs: [],
      deliveries: [{ id: 'delivery-1', status: 'unknown' }]
    }
    request.mockResolvedValue(detail)

    await expect(getCronRunDetail('cron-run-1', 'workspace-1')).resolves.toEqual(detail)
    expect(request).toHaveBeenCalledWith(
      'db/cron-run-detail',
      { runId: 'cron-run-1', workspaceId: 'workspace-1' },
      120_000
    )
  })

  it('continues to unwrap the legacy Native detail response envelope', async () => {
    request.mockResolvedValue({
      success: true,
      run: runDetail,
      job: null,
      messages: [],
      logs: [],
      deliveries: []
    })

    await expect(getCronRunDetail('cron-run-1', 'workspace-1')).resolves.toMatchObject({
      run: runDetail,
      deliveries: []
    })
  })

  it('preserves errors returned by the legacy Native detail response envelope', async () => {
    request.mockResolvedValue({ success: false, error: 'storage unavailable' })

    await expect(getCronRunDetail('cron-run-1', 'workspace-1')).rejects.toThrow(
      'storage unavailable'
    )
  })
})

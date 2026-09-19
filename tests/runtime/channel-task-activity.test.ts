import { expect, it } from 'vitest'
import {
  beginChannelTaskActivity,
  beginChannelTaskWorkspaceSwitch,
  hasActiveChannelTasks,
  isChannelTaskWorkspaceSwitching
} from '../../src/renderer/src/lib/channel/channel-task-activity'

it('blocks a workspace switch while a queued or running channel task is active', () => {
  const finishTask = beginChannelTaskActivity()
  expect(finishTask).not.toBeNull()
  expect(hasActiveChannelTasks()).toBe(true)
  expect(beginChannelTaskWorkspaceSwitch()).toBeNull()
  finishTask?.()
  finishTask?.()
  expect(hasActiveChannelTasks()).toBe(false)
})

it('defers new channel tasks until an asynchronous workspace switch ends', () => {
  const finishSwitch = beginChannelTaskWorkspaceSwitch()
  expect(finishSwitch).not.toBeNull()
  expect(isChannelTaskWorkspaceSwitching()).toBe(true)
  expect(beginChannelTaskWorkspaceSwitch()).toBeNull()
  expect(beginChannelTaskActivity()).toBeNull()
  finishSwitch?.()
  finishSwitch?.()
  expect(isChannelTaskWorkspaceSwitching()).toBe(false)
  const finishTask = beginChannelTaskActivity()
  expect(finishTask).not.toBeNull()
  finishTask?.()
})

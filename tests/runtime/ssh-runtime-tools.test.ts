import { describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn())
const workspace = vi.hoisted(() => vi.fn())
const fsTools = vi.hoisted(() => ({
  glob: vi.fn(),
  grep: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  text: vi.fn(),
  write: vi.fn()
}))

vi.mock('../../src/main/ipc/ssh-handlers', () => ({
  execSshCommand: exec,
  globSshRuntimeFiles: fsTools.glob,
  grepSshRuntimeFiles: fsTools.grep,
  listSshRuntimeDirectory: fsTools.list,
  readSshRuntimeFile: fsTools.read,
  readSshRuntimeText: fsTools.text,
  writeSshRuntimeFile: fsTools.write
}))
vi.mock('../../src/main/ssh/ssh-config', () => ({
  withSshWorkspace: (_id: string, run: () => unknown) => run()
}))
vi.mock('../../src/main/ssh/ssh-workspace-authorization', () => ({
  authorizeSshWorkspace: workspace
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: vi.fn()
}))

import { createSshRuntimeTools } from '../../src/main/runtime/ssh-runtime-tools'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const context: ToolContext = {
  run: {
    runId: 'run-a',
    taskId: 'task-a',
    requestId: 'request-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    environmentId: 'local',
    sshConnectionId: 'connection-a',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'test',
    unattended: false
  },
  signal: new AbortController().signal
}

describe('Main TS SSH runtime tool', () => {
  it('authorizes the workspace and executes without exposing credentials', async () => {
    workspace.mockResolvedValue('team-a')
    exec.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timing: { timedOut: false }
    })
    const tool = createSshRuntimeTools('connection-a').find((item) => item.name === 'Bash')!
    const input = tool.validate({ command: 'pwd' })
    await expect(tool.execute(input, context)).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false
    })
    expect(exec).toHaveBeenCalledWith('connection-a', 'pwd', 30_000)
    expect(workspace).toHaveBeenCalledWith('team-a', expect.any(Function))
  })

  it('rejects malformed commands and failed remote execution', async () => {
    const tool = createSshRuntimeTools('connection-a').find((item) => item.name === 'Bash')!
    expect(() => tool.validate({ command: '' })).toThrow('INVALID_TOOL_INPUT')
    workspace.mockResolvedValue('team-a')
    exec.mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'denied',
      error: 'denied'
    })
    await expect(tool.execute({ command: 'false', timeoutMs: 1000 }, context)).rejects.toThrow(
      'SSH_EXEC_FAILED'
    )
  })

  it('exposes every TS SSH filesystem tool through the authorized runtime surface', async () => {
    workspace.mockResolvedValue('team-a')
    fsTools.read.mockResolvedValue('  1\tline')
    fsTools.write.mockResolvedValue(undefined)
    fsTools.list.mockResolvedValue([{ name: 'a.txt' }])
    fsTools.glob.mockResolvedValue({ kind: 'glob', matches: [] })
    fsTools.grep.mockResolvedValue({ kind: 'grep', matches: [] })
    const tools = createSshRuntimeTools('connection-a')
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep', 'Bash'])
    )
    const read = tools.find((tool) => tool.name === 'Read')!
    const write = tools.find((tool) => tool.name === 'Write')!
    const ls = tools.find((tool) => tool.name === 'LS')!
    const glob = tools.find((tool) => tool.name === 'Glob')!
    const grep = tools.find((tool) => tool.name === 'Grep')!
    await expect(read.execute(read.validate({ file_path: '/tmp/a' }), context)).resolves.toBe(
      '  1\tline'
    )
    await expect(
      write.execute(write.validate({ file_path: '/tmp/a', content: 'x' }), context)
    ).resolves.toMatchObject({ success: true })
    await expect(ls.execute(ls.validate({ path: '/tmp' }), context)).resolves.toEqual([
      { name: 'a.txt' }
    ])
    await expect(
      glob.execute(glob.validate({ pattern: '*.txt', path: '/tmp' }), context)
    ).resolves.toMatchObject({ kind: 'glob' })
    await expect(
      grep.execute(grep.validate({ pattern: 'line', path: '/tmp' }), context)
    ).resolves.toMatchObject({ kind: 'grep' })
    expect(fsTools.read).toHaveBeenCalledWith('connection-a', '/tmp/a', 1, 2000)
    expect(fsTools.write).toHaveBeenCalledWith('connection-a', '/tmp/a', 'x')
  })
})

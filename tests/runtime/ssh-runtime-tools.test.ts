import { describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn())
const workspace = vi.hoisted(() => vi.fn())
const fsTools = vi.hoisted(() => ({
  glob: vi.fn(),
  grep: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  text: vi.fn(),
  stat: vi.fn(),
  write: vi.fn()
}))

vi.mock('../../src/main/ipc/ssh-handlers', () => ({
  execSshCommand: exec,
  globSshRuntimeFiles: fsTools.glob,
  grepSshRuntimeFiles: fsTools.grep,
  listSshRuntimeDirectory: fsTools.list,
  readSshRuntimeFile: fsTools.read,
  readSshRuntimeText: fsTools.text,
  statSshRuntimePath: fsTools.stat,
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
  it('collects only declared changed remote files after a successful shell command', async () => {
    workspace.mockResolvedValue('team-a')
    const tool = createSshRuntimeTools('connection-a').find((item) => item.name === 'Bash')!
    expect(() => tool.validate({ command: 'pwd', outputFiles: ['relative.txt'] })).toThrow(
      'INVALID_TOOL_INPUT'
    )
    expect(() => tool.validate({ command: 'pwd', outputFiles: ['/tmp/../secret'] })).toThrow(
      'INVALID_TOOL_INPUT'
    )
    const input = tool.validate({
      command: 'generate-report',
      outputFiles: ['/reports/new.txt', '/reports/old.txt']
    })
    fsTools.stat.mockReset()
    fsTools.stat
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, type: 'file', size: 5, mtimeMs: 1000 })
      .mockResolvedValueOnce({ exists: true, type: 'file', size: 10, mtimeMs: 2000 })
      .mockResolvedValueOnce({ exists: true, type: 'file', size: 5, mtimeMs: 1000 })
      .mockResolvedValueOnce({ exists: true, type: 'file' })
    exec.mockResolvedValue({ success: true, exitCode: 0, stdout: '/unrelated.txt', stderr: '' })
    const output = await tool.execute(input, context)
    expect(output).toMatchObject({ artifacts: [{ path: '/reports/new.txt', operation: 'create' }] })
    await expect(tool.artifacts?.(output, context)).resolves.toEqual([
      {
        kind: 'file',
        transport: 'ssh',
        connectionId: 'connection-a',
        path: '/reports/new.txt',
        operation: 'create'
      }
    ])
    fsTools.stat.mockResolvedValue({ exists: true, type: 'file', size: 10, mtimeMs: 2000 })
    exec.mockResolvedValue({ success: true, exitCode: 1, stdout: '', stderr: 'failed' })
    const failed = await tool.execute(input, context)
    expect(failed).toMatchObject({ artifacts: [] })
    await expect(tool.artifacts?.(failed, context)).resolves.toEqual([])
    exec.mockResolvedValue({ success: true, exitCode: 0, timing: { timedOut: true } })
    const timedOut = await tool.execute(input, context)
    await expect(tool.artifacts?.(timedOut, context)).resolves.toEqual([])
    fsTools.stat.mockReset()
  })
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
    expect(fsTools.read).toHaveBeenCalledWith('connection-a', '/tmp/a', 1, 2000, undefined)
    expect(fsTools.write).toHaveBeenCalledWith('connection-a', '/tmp/a', 'x')
  })

  it('passes the selected remote root to every read tool in an SSH scenario', async () => {
    workspace.mockResolvedValue('team-a')
    fsTools.read.mockResolvedValue('  1\tline')
    fsTools.list.mockResolvedValue([])
    fsTools.glob.mockResolvedValue({ kind: 'glob', matches: [] })
    fsTools.grep.mockResolvedValue({ kind: 'grep', matches: [] })
    const tools = createSshRuntimeTools('connection-a', '/srv/project')
    for (const [name, input] of [
      ['Read', { file_path: 'readme.md' }],
      ['LS', { path: '.' }],
      ['Glob', { pattern: '*.md', path: '.' }],
      ['Grep', { pattern: 'hello', path: '.' }]
    ] as const) {
      const tool = tools.find((item) => item.name === name)!
      await tool.execute(tool.validate(input), context)
    }
    expect(fsTools.read).toHaveBeenCalledWith('connection-a', 'readme.md', 1, 2000, '/srv/project')
    expect(fsTools.list).toHaveBeenCalledWith('connection-a', '.', '/srv/project')
    expect(fsTools.glob).toHaveBeenCalledWith('connection-a', '*.md', '.', '/srv/project')
    expect(fsTools.grep).toHaveBeenCalledWith(
      'connection-a',
      { pattern: 'hello', path: '.' },
      '/srv/project'
    )
  })

  it('registers a remote file only after an authorized remote stat confirms it exists', async () => {
    workspace.mockResolvedValue('team-a')
    fsTools.write.mockResolvedValue(undefined)
    fsTools.stat.mockResolvedValue({ exists: true, type: 'file' })
    const write = createSshRuntimeTools('connection-a').find((item) => item.name === 'Write')!
    const input = write.validate({ file_path: '/reports/q1.pdf', content: 'report' })
    const output = await write.execute(input, context)
    await expect(write.artifacts?.(output, context)).resolves.toEqual([
      {
        kind: 'file',
        transport: 'ssh',
        connectionId: 'connection-a',
        path: '/reports/q1.pdf',
        operation: 'create'
      }
    ])
    expect(fsTools.stat).toHaveBeenCalledWith('team-a', 'connection-a', '/reports/q1.pdf')

    fsTools.stat.mockResolvedValue({ exists: false, type: null })
    await expect(write.artifacts?.(output, context)).resolves.toEqual([])
  })
})

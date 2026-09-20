import { describe, expect, it } from 'vitest'
import {
  parseRemoteStatus,
  remoteGitCommand,
  remoteGitOperation
} from '../../src/main/ipc/git-handlers'

describe('remote Git TS contract', () => {
  it('builds a shell-safe git command for the ssh2 execution host', () => {
    expect(remoteGitCommand('/srv/Ola workspace', ['status', '--porcelain=v1'])).toBe(
      "'git' '-C' '/srv/Ola workspace' 'status' '--porcelain=v1'"
    )
    expect(remoteGitCommand('/srv/repo', ['show', "HEAD:it's.txt"])).toContain(
      "'HEAD:it'\\''s.txt'"
    )
  })

  it('maps the read-only remote operations to argument arrays', () => {
    expect(remoteGitOperation('get-head', {})).toMatchObject({ args: ['rev-parse', 'HEAD'] })
    expect(
      remoteGitOperation('get-file-content-at-ref', { ref: 'HEAD', filePath: 'a.txt' })
    ).toEqual(expect.objectContaining({ args: ['show', 'HEAD:a.txt'] }))
    expect(remoteGitOperation('get-commit-history', { limit: 12 }).args).toEqual([
      'log',
      '-12',
      '--format=%H%x01%h%x01%an%x01%ae%x01%aI%x01%s'
    ])
  })

  it('parses remote porcelain status without a Native Worker response', () => {
    expect(
      parseRemoteStatus('## main...origin/main [ahead 1, behind 2]\nM  staged.txt\n?? new.txt\n')
    ).toEqual({
      success: true,
      status: {
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        staged: [{ path: 'staged.txt' }],
        unstaged: [],
        untracked: [{ path: 'new.txt' }],
        conflicted: []
      }
    })
  })
})

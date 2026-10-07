import { describe, expect, it } from 'vitest'
import { resolveSshScenarioPath } from '../../src/main/ssh/ssh-scenario-scope'

const paths = new Map([
  ['/srv/project', '/srv/project'],
  ['/srv/project/readme.md', '/srv/project/readme.md'],
  ['/srv/project/sub', '/srv/project/sub'],
  ['/srv/project/sub/file.txt', '/srv/project/sub/file.txt'],
  ['/srv/project/escape', '/etc/passwd'],
  ['/srv/project-link', '/srv/project'],
  ['/srv/project-link/readme.md', '/srv/project/readme.md'],
  ['/etc/passwd', '/etc/passwd'],
  ['/srv/project-other/file.txt', '/srv/project-other/file.txt']
])
const realpath = async (path: string): Promise<string> => {
  const resolved = paths.get(path)
  if (!resolved) throw new Error('ENOENT')
  return resolved
}

describe('SSH scenario path scope', () => {
  it('resolves relative paths inside the canonical remote root', async () => {
    await expect(resolveSshScenarioPath(realpath, '/srv/project', '.')).resolves.toBe(
      '/srv/project'
    )
    await expect(resolveSshScenarioPath(realpath, '/srv/project', 'sub/file.txt')).resolves.toBe(
      '/srv/project/sub/file.txt'
    )
    await expect(resolveSshScenarioPath(realpath, '/srv/project-link', 'readme.md')).resolves.toBe(
      '/srv/project/readme.md'
    )
    await expect(
      resolveSshScenarioPath(realpath, '/srv/project-link', '/srv/project-link/readme.md')
    ).resolves.toBe('/srv/project/readme.md')
  })

  it('rejects parent traversal, sibling prefixes, absolute paths and escaping symlinks', async () => {
    for (const path of [
      '../project-other/file.txt',
      '/srv/project-other/file.txt',
      '/etc/passwd',
      'escape'
    ]) {
      await expect(resolveSshScenarioPath(realpath, '/srv/project', path)).rejects.toThrow(
        'SSH_SCENARIO_PATH_FORBIDDEN'
      )
    }
  })

  it('rejects lexical escapes before requesting their remote realpath', async () => {
    const probes: string[] = []
    const trackedRealpath = async (path: string): Promise<string> => {
      probes.push(path)
      return realpath(path)
    }
    await expect(
      resolveSshScenarioPath(trackedRealpath, '/srv/project', '../project-other/file.txt')
    ).rejects.toThrow('SSH_SCENARIO_PATH_FORBIDDEN')
    expect(probes).toEqual(['/srv/project'])

    probes.length = 0
    await expect(
      resolveSshScenarioPath(trackedRealpath, '/srv/project', '/etc/passwd')
    ).rejects.toThrow('SSH_SCENARIO_PATH_FORBIDDEN')
    expect(probes).toEqual(['/srv/project'])
  })
})

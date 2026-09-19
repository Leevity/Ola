import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hooksConfigPaths } from '../../src/main/hooks/hooks-loader'

it('uses the explicit Ola data root for global hooks and keeps project hooks local', () => {
  const home = join('/tmp', 'home')
  const dataRoot = join('/tmp', 'isolated-ola')
  const project = join('/tmp', 'project')
  expect(hooksConfigPaths(home, project, dataRoot)).toEqual([
    join(dataRoot, 'hooks.json'),
    join(project, '.ola', 'hooks.json')
  ])
  expect(hooksConfigPaths(home)).toEqual([join(home, '.ola', 'hooks.json')])
})

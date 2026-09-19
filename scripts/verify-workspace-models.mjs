/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'ola-model-selection-'))
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => {
    values.set(key, value)
  },
  removeItem: (key) => {
    values.delete(key)
  }
}
globalThis.window = { localStorage: globalThis.localStorage }
try {
  const result = await build({
    stdin: {
      contents: `export { useWorkspaceStore } from './src/renderer/src/stores/workspace-store';
      export { workspaceModelProviders, managedProviderConfig } from './src/renderer/src/lib/workspace-models';`,
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: 'tsconfig.web.json'
  })
  const filename = path.join(dir, 'models.mjs')
  await writeFile(filename, result.outputFiles[0].text)
  const { useWorkspaceStore, workspaceModelProviders, managedProviderConfig } = await import(
    pathToFileURL(filename).href
  )
  const state = () => useWorkspaceStore.getState()
  assert.equal(state().activeWorkspaceId, 'local-personal')
  assert.deepEqual(workspaceModelProviders(), [])
  state().setModelSelection('local-personal', { providerId: 'local-vllm', modelId: 'local-model' })
  state().replaceOlaWorkspaces([
    { id: 'team-a', kind: 'ola-team', name: 'A' },
    { id: 'team-b', kind: 'ola-team', name: 'B' }
  ])
  for (const workspaceId of ['team-a', 'team-b'])
    state().setResources(workspaceId, [
      {
        id: 'resource',
        workspaceId,
        providerName: 'Ola',
        model: 'actual-model',
        enabled: true,
        isDefault: true
      }
    ])
  assert.equal(
    state().activeWorkspaceId,
    'local-personal',
    'sync must not replace the local workspace or default'
  )
  state().setActiveWorkspace('team-a')
  state().setModelSelection('team-a', { providerId: 'ola-managed:team-a', modelId: 'resource' })
  assert.equal(workspaceModelProviders()[0].id, 'ola-managed:team-a')
  assert.equal(managedProviderConfig('ola-managed:team-a', 'resource').apiKey, '')
  assert.ok(
    managedProviderConfig('ola-managed:team-b', 'resource').baseUrl.includes('/unavailable/')
  )
  state().setActiveWorkspace('team-b')
  state().setModelSelection('team-b', { providerId: 'local-vllm', modelId: 'local-model' })
  assert.equal(state().modelSelections['team-a'].providerId, 'ola-managed:team-a')
  state().setActiveWorkspace('team-a')
  state().setResources('team-a', [])
  assert.ok(
    managedProviderConfig('ola-managed:team-a', 'resource').baseUrl.includes('/unavailable/'),
    'revocation must keep an unavailable binding rather than fall back'
  )
  state().clearOlaState()
  state().setResources('team-a', [
    {
      id: 'late-resource',
      workspaceId: 'team-a',
      providerName: 'Ola',
      model: 'late-model',
      enabled: true,
      isDefault: false
    }
  ])
  assert.equal(state().activeWorkspaceId, 'local-personal')
  assert.deepEqual(state().modelSelections['local-personal'], {
    providerId: 'local-vllm',
    modelId: 'local-model'
  })
  assert.deepEqual(state().resourcesByWorkspace, {})
  assert.deepEqual(workspaceModelProviders(), [])
  assert.ok(values.has('ola.workspace-context.v1'), 'workspace choices must persist')
  console.log('Offline workspace defaults, model source isolation and revoked bindings passed')
} finally {
  delete globalThis.window
  delete globalThis.localStorage
  await rm(dir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ExtensionManager } from '../src/main/extensions/extension-manager.ts'
import {
  ExtensionService,
  type ExtensionSecretStore
} from '../src/main/extensions/extension-service.ts'
import { ExtensionStateStore } from '../src/main/extensions/extension-state-store.ts'

class MemorySecrets implements ExtensionSecretStore {
  readonly values = new Map<string, string>()
  async get(id: string, key: string): Promise<string> {
    return this.values.get(id + ':' + key) ?? ''
  }
  async set(id: string, key: string, value: string): Promise<void> {
    this.values.set(id + ':' + key, value)
  }
  async delete(id: string, key: string): Promise<void> {
    this.values.delete(id + ':' + key)
  }
}

async function newHarness(): Promise<{
  root: string
  manager: ExtensionManager
  stateStore: ExtensionStateStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-lifecycle-'))
  const extensions = join(root, 'extensions')
  await mkdir(extensions, { recursive: true })
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const approvals = new ExtensionStateStore(join(root, 'extensions-approvals.json'))
  const service = new ExtensionService(extensions, stateStore, new MemorySecrets())
  const manager = new ExtensionManager(service, stateStore, {}, approvals)
  return { root, manager, stateStore }
}

const manifest = (id: string, version = '1') => ({
  schemaVersion: 1,
  id,
  name: id,
  version,
  permissions: { capabilities: { required: ['network.request'] } },
  tools: [{ name: 'fetch', kind: 'http', http: { url: 'https://api.example.com/data' } }]
})

// --- Lazy activation: scanning alone does not mark an extension active ---
{
  const h = await newHarness()
  try {
    await mkdir(join(h.root, 'extensions', 'alpha'), { recursive: true })
    await writeFile(
      join(h.root, 'extensions', 'alpha', 'extension.json'),
      JSON.stringify(manifest('alpha'))
    )
    const describe = await h.manager.describe('alpha')
    assert.equal(describe.lifecycle, 'idle') // scanned but not activated
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- A call activates; idle sweep later puts it back to sleep ---
{
  const h = await newHarness()
  try {
    await mkdir(join(h.root, 'extensions', 'beta'), { recursive: true })
    await writeFile(
      join(h.root, 'extensions', 'beta', 'extension.json'),
      JSON.stringify(manifest('beta'))
    )
    await h.stateStore.update('beta', { enabled: true })
    // A real install records the approval baseline before the first call; without it the manager
    // fails closed instead of trusting the manifest.
    await h.manager.checkEscalation('beta', { firstInstall: true })
    const call = await h.manager.handleCall('beta', 'http.request', {
      toolName: 'fetch',
      input: {}
    })
    assert.equal(call.decision, 'allow')
    const active = await h.manager.describe('beta')
    assert.equal(active.lifecycle, 'active') // lazy activation on first call
    // After the idle timeout the sweep transitions active → asleep.
    h.manager.startIdleSweep({ idleTimeoutMs: 0, sweepIntervalMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const asleep = await h.manager.describe('beta')
    assert.equal(asleep.lifecycle, 'asleep')
    h.manager.stopIdleSweep()
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- Disabled extension: calls are denied even through a direct handleCall (no UI bypass) ---
{
  const h = await newHarness()
  try {
    await mkdir(join(h.root, 'extensions', 'gamma'), { recursive: true })
    await writeFile(
      join(h.root, 'extensions', 'gamma', 'extension.json'),
      JSON.stringify(manifest('gamma'))
    )
    await h.stateStore.update('gamma', { enabled: false })
    const call = await h.manager.handleCall('gamma', 'http.request', {
      toolName: 'fetch',
      input: {}
    })
    assert.equal(call.decision, 'deny')
    if (call.decision === 'deny') assert.equal(call.reason, 'disabled')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

console.log('extension lifecycle verification passed')

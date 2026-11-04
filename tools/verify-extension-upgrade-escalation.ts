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

async function setupExtension(
  extensionsDir: string,
  manifest: Record<string, unknown>
): Promise<void> {
  await mkdir(join(extensionsDir, manifest.id as string), { recursive: true })
  await writeFile(
    join(extensionsDir, manifest.id as string, 'extension.json'),
    JSON.stringify(manifest)
  )
}

async function newHarness(): Promise<{
  root: string
  manager: ExtensionManager
  service: ExtensionService
  stateStore: ExtensionStateStore
  denied: { id: string; reason: string }[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-escalation-'))
  const extensions = join(root, 'extensions')
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const secrets = new MemorySecrets()
  const service = new ExtensionService(extensions, stateStore, secrets)
  const denied: { id: string; reason: string }[] = []
  const manager = new ExtensionManager(service, stateStore, {
    onDenied: (id, reason) => denied.push({ id, reason })
  })
  return { root, manager, service, stateStore, denied }
}

const httpTool = {
  name: 'fetch',
  kind: 'http',
  http: { url: 'https://api.example.com/data' }
}

// --- Scenario A: first install never enters pending-approval, grants its declared caps ---
{
  const h = await newHarness()
  try {
    await setupExtension(h.root + '/extensions', {
      schemaVersion: 1,
      id: 'first',
      name: 'First',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await h.stateStore.update('first', { enabled: true })
    const lifecycle = await h.manager.checkEscalation('first')
    assert.equal(lifecycle, 'idle') // no prior approval ⇒ not pending
    const describe = await h.manager.describe('first')
    assert.deepEqual(describe.granted, ['network.request']) // legacy-free state, granted == required
    assert.equal(describe.lifecycle, 'idle')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- Scenario B: upgrade widens required ⇒ pending-approval, and calls are blocked at the gate ---
{
  const h = await newHarness()
  try {
    const dir = join(h.root, 'extensions')
    await setupExtension(dir, {
      schemaVersion: 1,
      id: 'upg',
      name: 'Upg',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await h.stateStore.update('upg', { enabled: true })
    await h.manager.checkEscalation('upg')
    // Simulate an upgrade that adds a required capability.
    await setupExtension(dir, {
      schemaVersion: 1,
      id: 'upg',
      name: 'Upg',
      version: '2',
      permissions: { capabilities: { required: ['network.request', 'filesystem.read'] } },
      tools: [httpTool]
    })
    const lifecycle = await h.manager.checkEscalation('upg')
    assert.equal(lifecycle, 'pending-approval')
    // Even an IPC-direct call (which must route through handleCall) is denied while pending.
    const call = await h.manager.handleCall('upg', 'http.request', { toolName: 'fetch', input: {} })
    assert.equal(call.decision, 'deny')
    if (call.decision === 'deny') assert.equal(call.reason, 'pending-approval')
    assert.equal(h.denied.length, 1)
    assert.equal(h.denied[0].reason, 'pending-approval')
    // After re-approval the gate clears and the call is admitted.
    await h.manager.approveRequiredCapabilities('upg')
    const after = await h.manager.handleCall('upg', 'http.request', {
      toolName: 'fetch',
      input: {}
    })
    assert.equal(after.decision, 'allow')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- Scenario C: non-escalating upgrade (same required) stays idle, calls admitted ---
{
  const h = await newHarness()
  try {
    const dir = join(h.root, 'extensions')
    await setupExtension(dir, {
      schemaVersion: 1,
      id: 'same',
      name: 'Same',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await h.stateStore.update('same', { enabled: true })
    await h.manager.checkEscalation('same')
    await setupExtension(dir, {
      schemaVersion: 1,
      id: 'same',
      name: 'Same',
      version: '2',
      permissions: { capabilities: { required: ['network.request'], optional: ['clipboard'] } },
      tools: [httpTool]
    })
    const lifecycle = await h.manager.checkEscalation('same')
    assert.equal(lifecycle, 'idle') // optional growth is not escalation
    const call = await h.manager.handleCall('same', 'http.request', {
      toolName: 'fetch',
      input: {}
    })
    assert.equal(call.decision, 'allow')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- Scenario D: denied calls are logged to the activity hook ---
{
  const h = await newHarness()
  try {
    await setupExtension(h.root + '/extensions', {
      schemaVersion: 1,
      id: 'log',
      name: 'Log',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await h.stateStore.update('log', {
      enabled: true,
      granted: [],
      approvedRequired: ['network.request']
    })
    // network.request not granted ⇒ the call is denied and logged.
    const call = await h.manager.handleCall('log', 'http.request', { toolName: 'fetch', input: {} })
    assert.equal(call.decision, 'deny')
    assert.ok(h.denied.some((entry) => entry.id === 'log' && entry.reason === 'not-granted'))
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --- Scenario E: revoking a required capability disables the extension (cannot run partially) ---
{
  const h = await newHarness()
  try {
    await setupExtension(h.root + '/extensions', {
      schemaVersion: 1,
      id: 'rev',
      name: 'Rev',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await h.stateStore.update('rev', { enabled: true })
    await h.manager.revokeCapability('rev', ['network.request'])
    const after = await h.stateStore.get('rev')
    assert.equal(after?.enabled, false) // lost a required capability ⇒ disabled
    const call = await h.manager.handleCall('rev', 'http.request', { toolName: 'fetch', input: {} })
    assert.equal(call.decision, 'deny')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

console.log('extension upgrade escalation + IPC authorization verification passed')

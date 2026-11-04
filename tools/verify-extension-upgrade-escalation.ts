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
  approvals: ExtensionStateStore
  denied: { id: string; reason: string }[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-escalation-'))
  const extensions = join(root, 'extensions')
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const approvals = new ExtensionStateStore(join(root, 'extensions-approvals.json'))
  const secrets = new MemorySecrets()
  const service = new ExtensionService(extensions, stateStore, secrets)
  const denied: { id: string; reason: string }[] = []
  const manager = new ExtensionManager(
    service,
    stateStore,
    { onDenied: (id, reason) => denied.push({ id, reason }) },
    approvals
  )
  return { root, manager, service, stateStore, approvals, denied }
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
    const lifecycle = await h.manager.checkEscalation('first', { firstInstall: true })
    assert.equal(lifecycle, 'idle') // no prior approval ⇒ not pending
    const describe = await h.manager.describe('first')
    assert.deepEqual(describe.granted, ['network.request']) // legacy-free state, granted == required
    assert.equal(describe.lifecycle, 'idle')
    // The approval IPC must not be usable as a general privilege grant.
    await assert.rejects(
      h.manager.approveRequiredCapabilities('first'),
      /No capability approval is pending/
    )
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
    await h.manager.checkEscalation('upg', { firstInstall: true })
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
    await h.manager.checkEscalation('same', { firstInstall: true })
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
    // The approval baseline lives in its own file; seed it so this scenario exercises a missing
    // *grant* rather than a missing baseline (which would fail closed as `pending-approval`).
    await h.approvals.update('log', { approvedRequired: ['network.request'] })
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

// --- Scenario F: remove + reinstall must not reset the durable approval baseline ---
{
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-reinstall-'))
  const extensions = join(root, 'extensions')
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const approvalStore = new ExtensionStateStore(join(root, 'approvals.json'))
  const service = new ExtensionService(extensions, stateStore, new MemorySecrets())
  const manager = new ExtensionManager(service, stateStore, {}, approvalStore)
  try {
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'reinstall',
      name: 'Reinstall',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await stateStore.update('reinstall', { enabled: true })
    assert.equal(await manager.checkEscalation('reinstall', { firstInstall: true }), 'idle')

    // The UI upgrades by removing first, which clears the per-install state.
    await stateStore.delete('reinstall')
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'reinstall',
      name: 'Reinstall',
      version: '2',
      permissions: { capabilities: { required: ['network.request', 'process'] } },
      tools: [httpTool]
    })
    await stateStore.update('reinstall', { enabled: true })
    assert.equal(await manager.checkEscalation('reinstall'), 'pending-approval')
    assert.equal(
      (await manager.handleCall('reinstall', 'http.request', { toolName: 'fetch', input: {} }))
        .decision,
      'deny'
    )
    await manager.approveRequiredCapabilities('reinstall')
    assert.equal(
      (await manager.handleCall('reinstall', 'http.request', { toolName: 'fetch', input: {} }))
        .decision,
      'allow'
    )
    // Re-approving again without a fresh escalation is refused.
    await assert.rejects(
      manager.approveRequiredCapabilities('reinstall'),
      /No capability approval is pending/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// --- Scenario G: a lost approval baseline fails closed instead of adopting the new manifest ---
{
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-baseline-loss-'))
  const extensions = join(root, 'extensions')
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const approvalPath = join(root, 'approvals.json')
  const approvalStore = new ExtensionStateStore(approvalPath)
  const service = new ExtensionService(extensions, stateStore, new MemorySecrets())
  const manager = new ExtensionManager(service, stateStore, {}, approvalStore)
  try {
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'lost',
      name: 'Lost',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await stateStore.update('lost', { enabled: true })
    assert.equal(await manager.checkEscalation('lost', { firstInstall: true }), 'idle')
    // The durable baseline disappears while the extension stays installed. Reading that as a
    // first install would silently approve whatever the next manifest asks for.
    await rm(approvalPath, { force: true })
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'lost',
      name: 'Lost',
      version: '2',
      permissions: { capabilities: { required: ['network.request', 'process'] } },
      tools: [httpTool]
    })
    assert.equal(await manager.checkEscalation('lost'), 'pending-approval')
    assert.equal(
      (await manager.handleCall('lost', 'http.request', { toolName: 'fetch', input: {} })).decision,
      'deny'
    )
    // Re-approval is the only way out, and it records a fresh baseline.
    await manager.approveRequiredCapabilities('lost')
    assert.equal(
      (await manager.handleCall('lost', 'http.request', { toolName: 'fetch', input: {} })).decision,
      'allow'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// --- Scenario H: a call admitted before an upgrade cannot clear the pending gate when it ends ---
{
  const root = await mkdtemp(join(tmpdir(), 'ola-ext-touch-race-'))
  const extensions = join(root, 'extensions')
  const stateStore = new ExtensionStateStore(join(root, 'extensions.json'))
  const approvalStore = new ExtensionStateStore(join(root, 'approvals.json'))
  const realService = new ExtensionService(extensions, stateStore, new MemorySecrets())
  // A stub executor keeps the scenario offline; only the admission bookkeeping is under test.
  const service = {
    getRuntime: (id: string) => realService.getRuntime(id),
    executeHttpRequest: async () => ({ ok: true })
  } as unknown as ExtensionService
  const manager = new ExtensionManager(service, stateStore, {}, approvalStore)
  try {
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'race',
      name: 'Race',
      version: '1',
      permissions: { capabilities: { required: ['network.request'] } },
      tools: [httpTool]
    })
    await stateStore.update('race', { enabled: true })
    await manager.checkEscalation('race', { firstInstall: true })
    const admitted = await manager.handleCall('race', 'http.request', {
      toolName: 'fetch',
      input: {}
    })
    assert.equal(admitted.decision, 'allow')
    // An upgrade lands while the admitted call is still running.
    await setupExtension(extensions, {
      schemaVersion: 1,
      id: 'race',
      name: 'Race',
      version: '2',
      permissions: { capabilities: { required: ['network.request', 'process'] } },
      tools: [httpTool]
    })
    assert.equal(await manager.checkEscalation('race'), 'pending-approval')
    // The in-flight call finishes now; its bookkeeping must not resurrect `active`.
    if (admitted.decision === 'allow') await admitted.run()
    assert.equal((await manager.describe('race')).lifecycle, 'pending-approval')
    assert.equal(
      (await manager.handleCall('race', 'http.request', { toolName: 'fetch', input: {} })).decision,
      'deny'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('extension upgrade escalation + IPC authorization verification passed')

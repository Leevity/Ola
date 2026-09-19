/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'ola-bridge-'))
const originalFetch = globalThis.fetch
try {
  globalThis.olaBridgeFixture = { dir }
  const result = await build({
    stdin: {
      contents: `export { invokeRemoteAccount } from './src/main/remote/account-client';
        export { managedModelReverseRequest } from './src/main/remote/managed-model-bridge';
        export { publicWorkspaceDirectory, publicModelDirectory } from './src/shared/workspace-directory';`,
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'isolated-main-fixtures',
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^electron$|^\.\/mesh-node$|^\.\/authorization-state$|^\.\.\/db\/sessions-dao$/
            },
            (args) => ({ path: args.path, namespace: 'fixture' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'electron'
                ? `export const app = { isPackaged: false, getPath: () => globalThis.olaBridgeFixture.dir };
          export const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (s) => s.toString() };
          export const shell = { openExternal: async () => {} };`
                : args.path.endsWith('mesh-node')
                  ? `export const desktopMeshCapabilities = []; export const desktopMeshPlatform = () => 'macos'; export const loadDesktopMeshIdentity = async () => ({});`
                  : args.path.endsWith('sessions-dao')
                    ? `export const getSession = async (id) => id === 'session-a' ? { workspace_id: 'team-a' } : undefined;`
                    : `export const setRemoteControlAllowed = () => {};`
          }))
        }
      }
    ]
  })
  const modulePath = path.join(dir, 'bridge.mjs')
  await writeFile(modulePath, result.outputFiles[0].text)
  const api = await import(pathToFileURL(modulePath).href)
  const privateFields = {
    apiKey: 'secret-fixture',
    accessToken: 'secret-fixture',
    credentialRef: 'secret-fixture'
  }
  assert.ok(
    !JSON.stringify(
      api.publicWorkspaceDirectory({
        workspaces: [{ id: 'team-a', kind: 'team', ...privateFields }]
      })
    ).includes('secret-fixture')
  )
  assert.ok(
    !JSON.stringify(
      api.publicModelDirectory({
        resources: [{ id: 'model-a', model: 'upstream-model', enabled: true, ...privateFields }]
      })
    ).includes('secret-fixture')
  )
  assert.equal(
    api.publicModelDirectory({ resources: [{ id: 'model-a', model: 'model' }] }).resources[0]
      .enabled,
    false
  )
  const calls = []
  let rejectTicket = false
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/api/auth/login'))
      return Response.json({ token: 'account-secret', account: { id: 'account-a' } })
    if (url.endsWith('/api/devices/register')) return Response.json({ device: { id: 'device-a' } })
    if (url.endsWith('/api/auth/logout')) return Response.json({ success: true })
    if (url.endsWith('/api/account/model-access-ticket')) {
      assert.equal(options.headers.authorization, 'Bearer account-secret')
      assert.deepEqual(JSON.parse(options.body), {
        workspaceId: 'team-a',
        resourceId: 'resource-a',
        sessionId: 'session-a',
        deviceId: 'device-a'
      })
      return rejectTicket
        ? new Response('private upstream error', { status: 403 })
        : Response.json({ ticket: 'ticket-secret' })
    }
    assert.ok(url.endsWith('/v1/chat/completions'), url)
    assert.equal(options.headers.authorization, 'Bearer ticket-secret')
    return new Response('data: safe response\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    })
  }
  const account = (operation, payload = {}) =>
    api.invokeRemoteAccount({ apiBaseUrl: 'https://ola.example', operation, payload })
  await account('login', { email: 'fixture@example.test', password: 'fixture-password' })
  await account('device-register', {
    deviceName: 'Fixture',
    platform: 'macos',
    fingerprint: 'fixture'
  })
  const input = {
    url: 'https://ola.invalid/workspaces/team-a/resources/resource-a/v1/chat/completions',
    sessionId: 'session-a',
    body: Buffer.from('{"model":"resource-a"}').toString('base64'),
    contentType: 'application/json'
  }
  const opened = await api.managedModelReverseRequest('ola/model-open', input)
  assert.ok(!JSON.stringify(opened).includes('secret'))
  const chunk = await api.managedModelReverseRequest('ola/model-read', { handle: opened.handle })
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'data: safe response\n\n')
  await api.managedModelReverseRequest('ola/model-close', { handle: opened.handle })
  await assert.rejects(
    api.managedModelReverseRequest('ola/model-read', { handle: opened.handle }),
    /unavailable/
  )
  await assert.rejects(
    api.managedModelReverseRequest('ola/model-open', {
      ...input,
      url: input.url.replace('team-a', 'team-b')
    }),
    /workspace/
  )
  await assert.rejects(
    api.managedModelReverseRequest('ola/model-open', {
      ...input,
      url: input.url.replace('ola.invalid', 'attacker.example')
    }),
    /endpoint/
  )
  await assert.rejects(
    api.managedModelReverseRequest('ola/model-open', {
      ...input,
      url: input.url.replace('chat/completions', 'admin')
    }),
    /endpoint/
  )
  rejectTicket = true
  const gatewayCalls = () => calls.filter((call) => call.url.includes('/v1/')).length
  const before = gatewayCalls()
  await assert.rejects(
    api.managedModelReverseRequest('ola/model-open', input),
    /authorization unavailable/
  )
  assert.equal(
    gatewayCalls(),
    before,
    'authorization failure must not reach the gateway or fall back'
  )
  await account('logout')
  await assert.rejects(api.managedModelReverseRequest('ola/model-open', input), /Sign in/)
  assert.equal(gatewayCalls(), before)
  console.log(
    'Managed model credentials, endpoint restrictions, revocation and directory allowlists passed'
  )
} finally {
  globalThis.fetch = originalFetch
  delete globalThis.olaBridgeFixture
  await rm(dir, { recursive: true, force: true })
}

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve('examples/extensions/demo-extension')
const manifestPath = path.join(root, 'extension.json')
const errors = []

function assert(condition, message) {
  if (!condition) errors.push(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function validateManifest(manifest) {
  assert(manifest.schemaVersion === 1, 'schemaVersion must be 1')
  assert(/^[a-z0-9][a-z0-9_-]{1,63}$/.test(manifest.id ?? ''), 'invalid extension id')
  assert(manifest.id === 'demo_extension', 'demo extension id changed unexpectedly')
  assert(typeof manifest.name === 'string' && manifest.name.trim(), 'name is required')
  assert(typeof manifest.version === 'string' && manifest.version.trim(), 'version is required')
  assert(Array.isArray(manifest.tools) && manifest.tools.length === 3, 'expected 3 tools')
  assert(fs.existsSync(path.join(root, manifest.entry ?? '')), 'entry file is missing')

  const toolNames = new Set()
  for (const [index, tool] of (manifest.tools ?? []).entries()) {
    assert(isRecord(tool), `tool ${index} must be an object`)
    assert(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name ?? ''), `invalid tool ${index} name`)
    assert(!toolNames.has(tool.name), `duplicate tool name: ${tool.name}`)
    toolNames.add(tool.name)
    assert(tool.kind === 'http' || tool.kind === 'js', `tool ${tool.name} has invalid kind`)
    assert(isRecord(tool.inputSchema), `tool ${tool.name} must define inputSchema`)
    if (tool.kind === 'http') {
      assert(tool.http?.method && tool.http?.url, `http tool ${tool.name} is incomplete`)
    }
    if (tool.kind === 'js') {
      assert(
        typeof tool.handler === 'string' && tool.handler.trim(),
        `js tool ${tool.name} needs handler`
      )
    }
  }

  assert(toolNames.has('get_post'), 'missing get_post tool')
  assert(toolNames.has('show_table'), 'missing show_table tool')
  assert(toolNames.has('show_html'), 'missing show_html tool')

  const renderers = manifest.renderers ?? []
  assert(renderers.length === 1, 'expected 1 renderer')
  assert(renderers[0]?.name === 'summary_card', 'missing summary_card renderer')
  assert(fs.existsSync(path.join(root, renderers[0]?.entry ?? '')), 'renderer file is missing')
}

async function validateHandlers(manifest) {
  const entryCode = fs.readFileSync(path.join(root, manifest.entry), 'utf-8')
  const sandbox = {
    globalThis: {},
    console: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  }
  sandbox.globalThis = sandbox
  sandbox.fetch = () => {
    throw new Error('direct fetch should not be used by the demo extension')
  }
  sandbox.XMLHttpRequest = undefined
  sandbox.WebSocket = undefined
  sandbox.EventSource = undefined

  vm.runInNewContext(entryCode, sandbox, {
    filename: manifest.entry,
    timeout: 1000
  })

  const handlers = sandbox.openCoworkExtension?.handlers
  assert(isRecord(handlers), 'openCoworkExtension.handlers is missing')
  assert(typeof handlers.showTable === 'function', 'showTable handler is missing')
  assert(typeof handlers.showHtml === 'function', 'showHtml handler is missing')

  const ctx = {
    config: {},
    fetch: async () => {
      throw new Error('ctx.fetch is not needed by this demo handler')
    },
    storage: {
      get: async () => null,
      set: async () => ({ success: true }),
      delete: async () => ({ success: true })
    }
  }

  const tableResult = await handlers.showTable({}, ctx)
  assert(tableResult?.ui?.kind === 'table', 'showTable must return table UI')
  assert(
    Array.isArray(tableResult?.ui?.rows) && tableResult.ui.rows.length > 0,
    'showTable rows missing'
  )

  const htmlResult = await handlers.showHtml({ title: 'Smoke Test' }, ctx)
  assert(htmlResult?.ui?.kind === 'html', 'showHtml must return html UI')
  assert(htmlResult?.ui?.renderer === 'summary_card', 'showHtml renderer mismatch')
  assert(htmlResult?.ui?.props?.title === 'Smoke Test', 'showHtml props title mismatch')
}

function validateRenderer(manifest) {
  const renderer = manifest.renderers.find((item) => item.name === 'summary_card')
  const html = fs.readFileSync(path.join(root, renderer.entry), 'utf-8')
  assert(html.includes('extension-props'), 'renderer must listen for extension-props')
  assert(html.includes('escapeHtml'), 'renderer should escape injected values')
}

const manifest = readJson(manifestPath)
validateManifest(manifest)
await validateHandlers(manifest)
validateRenderer(manifest)

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exit(1)
}

console.log('Extension example smoke test passed')

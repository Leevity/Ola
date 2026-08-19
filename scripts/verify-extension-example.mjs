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
  assert(manifest.id === 'demo-extension', 'demo extension id changed unexpectedly')
  assert(typeof manifest.name === 'string' && manifest.name.trim(), 'name is required')
  assert(typeof manifest.version === 'string' && manifest.version.trim(), 'version is required')
  assert(Array.isArray(manifest.tools) && manifest.tools.length > 0, 'expected at least one tool')
  if (manifest.entry) {
    assert(fs.existsSync(path.join(root, manifest.entry)), 'entry file is missing')
  }

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

  for (const renderer of manifest.renderers ?? []) {
    assert(typeof renderer.name === 'string' && renderer.name.trim(), 'renderer name is required')
    assert(fs.existsSync(path.join(root, renderer.entry ?? '')), 'renderer file is missing')
  }
}

async function validateHandlers(manifest) {
  if (!manifest.entry) return

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

  const handlers = (sandbox.olaExtension || sandbox.openCoworkExtension)?.handlers
  assert(isRecord(handlers), 'olaExtension.handlers is missing')
  const jsTools = manifest.tools.filter((tool) => tool.kind === 'js')
  for (const tool of jsTools) {
    assert(typeof handlers[tool.handler] === 'function', `${tool.handler} handler is missing`)
  }

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

  for (const tool of jsTools) {
    const result = await handlers[tool.handler]({}, ctx)
    assert(result !== undefined, `${tool.handler} must return a result`)
  }
}

function validateGeneratedTemplate() {
  const templatePath = path.resolve('resources/skills/create-extension/scripts/create_extension.py')
  const template = fs.readFileSync(templatePath, 'utf-8')
  assert(template.includes('globalThis.olaExtension'), 'generated extensions must use olaExtension')
}

const manifest = readJson(manifestPath)
validateManifest(manifest)
await validateHandlers(manifest)
validateGeneratedTemplate()

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exit(1)
}

console.log('Extension example smoke test passed')

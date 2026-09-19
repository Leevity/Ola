import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const runtime = await readFile('src/main/ipc/extension-js-runtime.ts', 'utf8')
assert.doesNotMatch(runtime, /from 'vm'|vm\.createContext|new vm\.Script|runInContext/)
assert.match(runtime, /JavaScript extensions are quarantined/)
assert.doesNotMatch(runtime, /nativeExtensionRequest|readExtensionAsset/)

console.log('JavaScript extension quarantine verification passed')

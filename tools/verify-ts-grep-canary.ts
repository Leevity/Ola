import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main/ipc/fs-handlers.ts', import.meta.url), 'utf8')
if (!source.includes('if (canUseTsLocalGrep(args))')) {
  throw new Error('Supported local grep semantics must use the TS engine by default')
}
if (!source.includes("nativeToolRequest<GrepToolResult>(\n      'fs/grep'")) {
  throw new Error('Native grep fallback must remain for unsupported advanced semantics')
}
console.log('TS grep default route and fallback boundary verification passed')

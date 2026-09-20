import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/main/ipc/fs-handlers.ts', import.meta.url), 'utf8')
if (!source.includes('if (canUseTsLocalGrep(args))')) {
  throw new Error('Supported local grep semantics must use the TS engine by default')
}
if (source.includes('legacyNativeCompatibilityEnabled()')) {
  throw new Error('Legacy grep compatibility must not remain in the production path')
}
if (!source.includes("error: 'TS_GREP_UNSUPPORTED_OPTIONS'")) {
  throw new Error('Unsupported grep semantics must fail explicitly in production')
}
console.log('TS grep default route and explicit compatibility boundary verification passed')

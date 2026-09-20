import { expect, it } from 'vitest'
import { getTsCodeGraphStatus } from '../../src/main/ipc/codegraph-handlers'
import { WASM_CODEGRAPH_LANGUAGES } from '../../src/runtime/codegraph/wasm-parser'

it('reports the current TS/WASM grammar matrix instead of stale worker counts', () => {
  const status = getTsCodeGraphStatus()
  expect(status.runtime).toBe('ts-wasm')
  expect(status.grammarStatus.expected).toBe(WASM_CODEGRAPH_LANGUAGES.length)
  expect(status.grammarStatus.available + status.grammarStatus.missing.length).toBe(
    WASM_CODEGRAPH_LANGUAGES.length
  )
  expect(status.grammarStatus.expected).toBe(18)
})

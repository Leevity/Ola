import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
    // Node 25's concurrent WASM compiler can exhaust the desktop test host
    // while SQLite-backed fixtures are also running. One worker keeps the
    // full runtime suite deterministic and prevents false-negative OOMs.
    maxWorkers: 1,
    execArgv: ['--wasm-num-compilation-tasks=1', '--no-wasm-async-compilation']
  }
})

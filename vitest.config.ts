import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const alias = { '@renderer': resolve('src/renderer/src') }
const shared = {
  environment: 'node',
  restoreMocks: true,
  testTimeout: 15000
} as const

// Node 25's concurrent WASM compiler can exhaust the desktop test host, and the
// Electron suites launch real app instances. Those stay single-worker; everything
// else is CPU-bound and safe to fan out. One global maxWorkers: 1 used to make the
// whole 338-file suite pay for the handful that actually need it.
const WASM_INCLUDE = [
  'tests/runtime/codegraph-*.test.ts',
  'tests/runtime/ts-codegraph-service.test.ts'
]
const SERIAL_INCLUDE = [
  'tests/runtime/*-electron.test.ts',
  'tests/runtime/cli.test.ts',
  'tests/runtime/isolated-runtime-crash.test.ts',
  'tests/runtime/no-dotnet-artifacts.test.ts',
  'tests/runtime/release-notes-preparation.test.ts',
  'tests/runtime/runtime-staging-integrity.test.ts'
]

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'wasm',
          include: WASM_INCLUDE,
          maxWorkers: 1,
          execArgv: ['--wasm-num-compilation-tasks=1', '--no-wasm-async-compilation']
        }
      },
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'serial',
          include: SERIAL_INCLUDE,
          maxWorkers: 1
        }
      },
      {
        resolve: { alias },
        test: {
          ...shared,
          name: 'default',
          include: ['tests/**/*.test.ts'],
          exclude: [...WASM_INCLUDE, ...SERIAL_INCLUDE],
          maxWorkers: 4
        }
      }
    ]
  }
})

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const script = resolve('scripts/package-release-staging.mjs')

describe('release staging output guard', () => {
  it.each(['../out', 'out', 'dist/../../src', 'dist\\..\\src', '/tmp/dist'])(
    'rejects unsafe output %s before staging',
    async (output) => {
      await expect(
        run(process.execPath, [script, '--linux', '--x64', `--output=${output}`])
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          'Release output must be dist or a dist- prefixed directory name'
        )
      })
    }
  )
})

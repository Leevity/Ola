import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearBusinessHandoverMarker,
  readBusinessHandoverMarker,
  writeBusinessHandoverMarker
} from '../../src/main/db/business-handover-state'

describe('business handover restart marker', () => {
  const originalRoot = process.env.OLA_E2E_DATA_ROOT
  let directory = ''

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
    else process.env.OLA_E2E_DATA_ROOT = originalRoot
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('writes a private marker atomically and clears it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ola-handover-marker-'))
    await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    await chmod(directory, 0o700)
    process.env.OLA_E2E_DATA_ROOT = directory

    const marker = writeBusinessHandoverMarker({
      manifestPath: join(directory, 'backup', 'data.db.manifest.json'),
      backupPath: join(directory, 'backup', 'data.db')
    })
    expect(readBusinessHandoverMarker()).toEqual(marker)
    const raw = await readFile(join(directory, 'business-handover.active.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, manifestPath: marker.manifestPath })
    clearBusinessHandoverMarker()
    expect(readBusinessHandoverMarker()).toBeNull()
  })
})

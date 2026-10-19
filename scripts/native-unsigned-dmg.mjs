/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native Node JavaScript helper. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
const execute = promisify(execFile)

/** @param {string} content @param {string} output @param {string} volumeName */
export function nativeDmgArguments(content, output, volumeName) {
  if (!isAbsolute(content) || !isAbsolute(output)) throw new Error('DMG paths must be absolute')
  const outside = relative(content, output)
  if (!(outside === '..' || outside.startsWith(`..${sep}`)) || !output.endsWith('.dmg'))
    throw new Error('DMG output must be outside its content directory and end in .dmg')
  if (!volumeName || /[\r\n\0]/.test(volumeName)) throw new Error('Invalid DMG volume name')
  return [
    'create',
    '-ov',
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-volname',
    volumeName,
    '-srcfolder',
    content,
    output
  ]
}

/**
 * Build the unsigned drag-install image with the native read-only image creator.
 * No global disk/indexing settings or unrelated mounted devices are touched.
 * @param {{appPath: string, output: string, volumeName: string}} options
 */
export async function createNativeUnsignedDmg({ appPath, output, volumeName }) {
  if (process.platform !== 'darwin') throw new Error('Native DMG creation requires macOS')
  if (!isAbsolute(appPath) || !appPath.endsWith('.app'))
    throw new Error('Expected an absolute app bundle path')
  if (!(await stat(join(appPath, 'Contents', 'Info.plist'))).isFile())
    throw new Error('App bundle metadata missing')
  nativeDmgArguments(appPath, output, volumeName)
  await mkdir(dirname(output), { recursive: true })
  const content = await mkdtemp(join(dirname(output), '.ola-dmg-content-'))
  try {
    const args = nativeDmgArguments(content, output, volumeName)
    await writeFile(join(content, '.metadata_never_index'), '')
    await cp(appPath, join(content, basename(appPath)), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(content, 'Applications'))
    const result = await execute('/usr/bin/hdiutil', args, { maxBuffer: 10 * 1024 * 1024 })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    await execute('/usr/bin/hdiutil', ['verify', output], { maxBuffer: 10 * 1024 * 1024 })
    console.log('Native unsigned DMG created and verified')
  } finally {
    await rm(content, { recursive: true, force: true })
  }
}

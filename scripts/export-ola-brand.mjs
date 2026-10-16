/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, '..')
const sourcePath = resolve(root, 'packages/ola-design/assets/ola-icon.png')
const manifestPath = resolve(root, 'packages/ola-design/generated/brand-assets.json')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceHash = hash(await readFile(sourcePath))
const monochromeSourcePath = resolve(root, 'scripts/export-ola-mono-icon.swift')
const monochromeSourceHash = hash(await readFile(monochromeSourcePath))

if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.monochromeSourceHash !== monochromeSourceHash)
    throw new Error('Monochrome source changed; export again')
  if (manifest.sourceHash !== sourceHash) throw new Error('Brand source changed; export again')
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (hash(await readFile(resolve(workspace, path))) !== expected)
      throw new Error(`Brand asset out of sync: ${path}`)
  }
  console.log(`Ola brand: ${Object.keys(manifest.files).length} exported assets verified`)
} else {
  if (process.platform !== 'darwin')
    throw new Error('Export assets on macOS with sips; --check works on all platforms')
  const temporary = await mkdtemp(resolve(tmpdir(), 'ola-brand-export-'))
  try {
    const sizes = new Map()
    const png = async (size) => {
      if (!sizes.has(size)) {
        const path = resolve(temporary, `${size}.png`)
        execFileSync('/usr/bin/sips', ['-z', `${size}`, `${size}`, sourcePath, '--out', path])
        sizes.set(size, await readFile(path))
      }
      return sizes.get(size)
    }
    const outputs = new Map()
    execFileSync('/usr/bin/swift', [monochromeSourcePath, resolve(root, 'resources')])
    for (const name of ['trayTemplate.png', 'trayTemplate@2x.png'])
      outputs.set(`Ola/resources/${name}`, await readFile(resolve(root, 'resources', name)))
    for (const path of [
      'Ola/build/icon.png',
      'Ola/resources/icon.png',
      'Ola/resources/icon-mac.png',
      'Ola/src/renderer/src/assets/ola-brand-icon.png',
      'Ola-admin/public/ola-brand-icon.png',
      'ola-mobile/src/android/app/src/main/res/drawable-nodpi/ola_brand_icon.png',
      'ola-mobile/src/ios/Assets.xcassets/AppIcon.appiconset/Icon-1024.png',
      'ola-mobile/src/ios/Assets.xcassets/AppIcon.appiconset/Icon-1024-Dark.png',
      ...['Light', 'Dark', 'LegacyLight', 'LegacyDark'].map(
        (name) => `ola-mobile/src/ios/Resources/AlternateIcons/AppIcon-${name}.png`
      )
    ])
      outputs.set(path, await png(1024))
    for (const [density, size] of [
      ['mdpi', 48],
      ['hdpi', 72],
      ['xhdpi', 96],
      ['xxhdpi', 144],
      ['xxxhdpi', 192]
    ]) {
      for (const qualifier of ['', 'night-']) {
        outputs.set(
          `ola-mobile/src/android/app/src/main/res/mipmap-${qualifier}${density}/ic_launcher.png`,
          await png(size)
        )
      }
    }
    // Windows ICO supports PNG entries up to 256px; keep small sizes for shell rendering.
    const iconSizes = [16, 24, 32, 48, 64, 128, 256]
    const entries = await Promise.all(iconSizes.map(png))
    const header = Buffer.alloc(6 + entries.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(entries.length, 4)
    let offset = header.length
    for (let index = 0; index < entries.length; index++) {
      const entry = 6 + index * 16
      header[entry] = iconSizes[index] % 256
      header[entry + 1] = iconSizes[index] % 256
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(entries[index].length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += entries[index].length
    }
    const ico = Buffer.concat([header, ...entries])
    outputs.set('Ola/build/icon.ico', ico)
    outputs.set('Ola/resources/icon.ico', ico)
    for (const [path, bytes] of outputs) {
      const target = resolve(workspace, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          source: 'packages/ola-design/assets/ola-icon.png',
          sourceHash,
          monochromeSource: 'scripts/export-ola-mono-icon.swift',
          monochromeSourceHash,
          files: Object.fromEntries([...outputs].map(([path, bytes]) => [path, hash(bytes)]))
        },
        null,
        2
      ) + '\n'
    )
    console.log(`Ola brand: ${outputs.size} platform assets exported`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

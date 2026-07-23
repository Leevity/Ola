/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)

function readArgument(name) {
  const index = args.indexOf(name)
  if (index === -1 || !args[index + 1]) {
    throw new Error(`Missing required argument: ${name}`)
  }
  return args[index + 1]
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return listFiles(file)
    return entry.isFile() ? [file] : []
  })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function readPackageComponents() {
  const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const packages = lockfile.packages ?? {}
  return Object.entries(packages)
    .filter(([path, metadata]) => path.startsWith('node_modules/') && metadata?.version)
    .map(([path, metadata]) => ({
      name: path.slice('node_modules/'.length),
      versionInfo: metadata.version,
      downloadLocation: metadata.resolved ?? 'NOASSERTION',
      checksums: metadata.integrity
        ? [
            {
              algorithm: 'SHA512',
              checksumValue: metadata.integrity.replace(/^sha512-/, '')
            }
          ]
        : undefined
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function writeSpdxSbom(file, artifacts) {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  const created = new Date().toISOString()
  const rootPackageId = `SPDXRef-Package-${packageJson.name}`
  const packages = [
    {
      SPDXID: rootPackageId,
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION'
    },
    ...readPackageComponents().map((component, index) => ({
      SPDXID: `SPDXRef-Dependency-${index + 1}`,
      name: component.name,
      versionInfo: component.versionInfo,
      downloadLocation: component.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(component.checksums ? { checksums: component.checksums } : {})
    }))
  ]
  const files = artifacts.map((artifact, index) => ({
    SPDXID: `SPDXRef-Artifact-${index + 1}`,
    fileName: `./${artifact.name}`,
    checksums: [
      {
        algorithm: 'SHA256',
        checksumValue: artifact.sha256
      }
    ],
    licenseConcluded: 'NOASSERTION',
    licenseInfoInFiles: ['NOASSERTION'],
    copyrightText: 'NOASSERTION'
  }))
  const relationships = [
    ...packages.slice(1).map((dependency) => ({
      spdxElementId: rootPackageId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: dependency.SPDXID
    })),
    ...files.map((artifact) => ({
      spdxElementId: rootPackageId,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: artifact.SPDXID
    }))
  ]

  writeFileSync(
    file,
    `${JSON.stringify(
      {
        SPDXID: 'SPDXRef-DOCUMENT',
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        name: `${packageJson.name}-release-sbom`,
        documentNamespace: `https://spdx.org/spdxdocs/${packageJson.name}-${packageJson.version}-${created.replace(/[:.]/g, '-')}`,
        creationInfo: {
          created,
          creators: ['Tool: Ola release artifact verifier']
        },
        packages,
        files,
        relationships
      },
      null,
      2
    )}\n`
  )
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`
    )
  }
}

function assertWindowsArtifact(artifact, requireSignature) {
  if (extname(artifact).toLowerCase() !== '.exe') return
  if (readFileSync(artifact).subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error(`Windows artifact is not a PE executable: ${artifact}`)
  }
  if (requireSignature) {
    run('powershell', [
      '-NoProfile',
      '-Command',
      `$signature = Get-AuthenticodeSignature -FilePath '${artifact.replace(/'/g, "''")}'; if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }`
    ])
  }
}

function findMacApp(smokeDir) {
  if (!existsSync(smokeDir)) return undefined
  const candidates = listFiles(smokeDir)
    .filter((file) => file.endsWith('.app/Contents/Info.plist'))
    .map((file) => resolve(file, '..', '..'))
  return candidates[0]
}

function assertMacArtifact(artifacts, smokeDir, requireSignature) {
  const dmg = artifacts.find((artifact) => extname(artifact).toLowerCase() === '.dmg')
  const zip = artifacts.find((artifact) => extname(artifact).toLowerCase() === '.zip')
  if (!dmg || !zip) {
    throw new Error('macOS release assets must include both dmg and zip packages')
  }
  const app = findMacApp(smokeDir)
  if (!app) {
    throw new Error(`macOS packed app bundle was not found under ${smokeDir}`)
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  if (requireSignature) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
    run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      dmg
    ])
  }
}

function assertLinuxArtifact(artifacts) {
  const deb = artifacts.find((artifact) => extname(artifact).toLowerCase() === '.deb')
  const appImage = artifacts.find((artifact) => extname(artifact).toLowerCase() === '.appimage')
  if (!deb && !appImage)
    throw new Error('Linux release assets must include a deb or AppImage package')
  if (deb && readFileSync(deb).subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    throw new Error(`Linux deb artifact is invalid: ${deb}`)
  }
  if (appImage && statSync(appImage).size < 1024 * 1024) {
    throw new Error(`Linux AppImage artifact is unexpectedly small: ${appImage}`)
  }
}

const platform = readArgument('--platform')
const assetsDirectory = resolve(readArgument('--assets'))
const sbomPath = resolve(readArgument('--sbom'))
const checksumsPath = resolve(
  args.includes('--checksums')
    ? readArgument('--checksums')
    : join(assetsDirectory, 'SHA256SUMS.txt')
)
const smokeDir = resolve(args.includes('--smoke-dir') ? readArgument('--smoke-dir') : 'dist')
const requireSignature = process.env.OLA_RELEASE_REQUIRED === 'true'

if (!existsSync(assetsDirectory))
  throw new Error(`Assets directory does not exist: ${assetsDirectory}`)
const excludedNames = new Set([basename(sbomPath), basename(checksumsPath)])
const artifacts = listFiles(assetsDirectory)
  .filter((file) => !excludedNames.has(basename(file)))
  .filter((file) => !file.endsWith('.blockmap'))
  .filter((file) => !file.endsWith('.yml'))
  .filter((file) => !file.endsWith('.spdx.json'))
  .filter((file) => !/^SHA256SUMS(?:-|\.)/.test(basename(file)))

if (artifacts.length === 0) throw new Error(`No release artifacts found in ${assetsDirectory}`)

switch (platform) {
  case 'win':
    artifacts.forEach((artifact) => assertWindowsArtifact(artifact, requireSignature))
    break
  case 'mac':
    assertMacArtifact(artifacts, smokeDir, requireSignature)
    break
  case 'linux':
    assertLinuxArtifact(artifacts)
    break
  default:
    throw new Error(`Unsupported platform: ${platform}`)
}

const hashedArtifacts = artifacts.map((file) => ({
  name: relative(assetsDirectory, file),
  sha256: sha256(file),
  size: statSync(file).size
}))
writeFileSync(
  checksumsPath,
  `${hashedArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`
)
writeSpdxSbom(sbomPath, hashedArtifacts)
console.log(
  `release artifact verification passed for ${platform}: ${hashedArtifacts.length} artifact(s)`
)

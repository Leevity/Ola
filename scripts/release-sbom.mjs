/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native Node JavaScript uses JSDoc types. */
/** @typedef {{name: string, version: string}} ApplicationManifest */
/** @typedef {{name: string, versionInfo: string, path: string}} InstalledComponent */
/** @typedef {{name: string, sha256: string}} ReleaseArtifact */
/** @typedef {{name: string, versionInfo: string, licenseDeclared: string, downloadLocation: string,
 * source: string, repository: string, checksumsFile: string, checksumsSha256: string,
 * files: {fileName: string, sha256: string, size: number}[]}} BundledComponent */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const asar = createRequire(import.meta.url)('@electron/asar')
const packageManifestPath =
  /^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*package\.json$/i

/** @param {string} entry @returns {string} */
function normalizeArchivePath(entry) {
  return entry
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
}

/** @param {string} archivePath @param {string} original @param {string} normalized */
function extractManifest(archivePath, original, normalized) {
  // @electron/asar lists entries with a leading separator and, on Windows,
  // backslash separators that extraction rejects; try each accepted spelling.
  for (const candidate of [
    original,
    normalized,
    normalized.split('/').join('\\'),
    `/${normalized}`
  ]) {
    try {
      return asar.extractFile(archivePath, candidate)
    } catch {
      continue
    }
  }
  return undefined
}

/** @param {string} root @returns {string[]} */
function listFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name)
    return entry.isDirectory() ? listFiles(file) : entry.isFile() ? [file] : []
  })
}

/**
 * Inventory installed manifests from the actual archive, never the development lockfile.
 * @param {string} archivePath
 * @returns {{manifest: ApplicationManifest, components: InstalledComponent[]}}
 */
export function readPackagedInventory(archivePath) {
  /** @type {ApplicationManifest} */
  const manifest = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'))
  if (
    typeof manifest.name !== 'string' ||
    !manifest.name ||
    typeof manifest.version !== 'string' ||
    !manifest.version
  )
    throw new Error('Packaged app manifest lacks name/version')
  const archiveComponents = asar
    .listPackage(archivePath)
    // @electron/asar emits slash-separated paths on Unix and can expose
    // backslash-separated paths on Windows; SPDX inventory is platform-neutral.
    .map((original) => ({ original, normalized: normalizeArchivePath(original) }))
    .filter(({ normalized }) => packageManifestPath.test(normalized))
    .map(({ original, normalized }) => {
      const content = extractManifest(archivePath, original, normalized)
      if (!content) return undefined
      const data = JSON.parse(content.toString('utf8'))
      if (
        typeof data.name !== 'string' ||
        !data.name ||
        typeof data.version !== 'string' ||
        !data.version
      ) {
        throw new Error(`Packaged dependency manifest lacks name/version: ${normalized}`)
      }
      return { name: data.name, versionInfo: data.version, path: normalized }
    })
    .filter((component) => component !== undefined)

  const unpackedRoot = `${archivePath}.unpacked`
  const unpackedComponents = existsSync(unpackedRoot)
    ? listFiles(unpackedRoot)
        .map((file) => ({
          file,
          normalized: normalizeArchivePath(relative(unpackedRoot, file))
        }))
        .filter(({ normalized }) => packageManifestPath.test(normalized))
        .map(({ file, normalized }) => {
          const data = JSON.parse(readFileSync(file, 'utf8'))
          if (
            typeof data.name !== 'string' ||
            !data.name ||
            typeof data.version !== 'string' ||
            !data.version
          ) {
            throw new Error(`Packaged dependency manifest lacks name/version: ${normalized}`)
          }
          return {
            name: data.name,
            versionInfo: data.version,
            path: normalizeArchivePath(relative(dirname(archivePath), file))
          }
        })
    : []

  const components = [...archiveComponents, ...unpackedComponents]
    .filter(
      (component, index, all) =>
        all.findIndex((candidate) => candidate.path === component.path) === index
    )
    .sort((a, b) => a.path.localeCompare(b.path))
  if (components.length === 0)
    throw new Error('No installed dependency manifests in packaged archive')
  return { manifest, components }
}

/** @param {string} directory @returns {string} */
export function findPackagedArchive(directory) {
  /** @type {string[]} */
  const archives = []
  /** @param {string} path @returns {void} */
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile() && entry.name === 'app.asar') archives.push(resolve(fullPath))
    }
  }
  visit(directory)
  if (archives.length !== 1) {
    throw new Error(
      `Expected exactly one packaged app.asar under ${directory}; found ${archives.length}`
    )
  }
  return archives[0]
}

/** @param {ApplicationManifest} manifest
 * @param {InstalledComponent[]} components
 * @param {ReleaseArtifact[]} artifacts
 * @param {BundledComponent[]} [bundled]
 * @param {string} [created]
 */
export function createReleaseSbom(
  manifest,
  components,
  artifacts,
  bundled = [],
  created = new Date().toISOString()
) {
  const rootPackageId = 'SPDXRef-Package-Application'
  const packages = [
    {
      SPDXID: rootPackageId,
      name: manifest.name,
      versionInfo: manifest.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION'
    },
    ...components.map((component, index) => ({
      SPDXID: `SPDXRef-Dependency-${index + 1}`,
      name: component.name,
      versionInfo: component.versionInfo,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      comment: `Installed manifest: ${component.path}`
    })),
    ...bundled.map((entry, index) => {
      if (!entry.name || !entry.versionInfo || !entry.licenseDeclared) {
        throw new Error('Bundled component lacks name/version/license')
      }
      if (!/^https:\/\/[^\s]+$/.test(entry.downloadLocation)) {
        throw new Error(`Bundled component ${entry.name} lacks an https source URL`)
      }
      return {
        SPDXID: `SPDXRef-Bundled-${index + 1}`,
        name: entry.name,
        versionInfo: entry.versionInfo,
        downloadLocation: entry.downloadLocation,
        filesAnalyzed: true,
        licenseConcluded: entry.licenseDeclared,
        licenseDeclared: entry.licenseDeclared,
        copyrightText: 'NOASSERTION',
        comment: `Bundled native binaries, pinned by ${entry.source}; upstream checksums at ${entry.checksumsFile} (sha256 ${entry.checksumsSha256}); source repository ${entry.repository}`
      }
    })
  ]
  const files = artifacts.map((artifact, index) => {
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256))
      throw new Error(`Invalid artifact SHA256: ${artifact.name}`)
    return {
      SPDXID: `SPDXRef-Artifact-${index + 1}`,
      fileName: `./${artifact.name}`,
      checksums: [{ algorithm: 'SHA256', checksumValue: artifact.sha256.toLowerCase() }],
      licenseConcluded: 'NOASSERTION',
      licenseInfoInFiles: ['NOASSERTION'],
      copyrightText: 'NOASSERTION'
    }
  })
  const bundledFiles = bundled.flatMap((entry, componentIndex) => {
    const owner = `SPDXRef-Bundled-${componentIndex + 1}`
    return entry.files.map((file, fileIndex) => {
      if (!/^[a-f0-9]{64}$/i.test(file.sha256))
        throw new Error(`Invalid bundled binary SHA256: ${file.fileName}`)
      return {
        SPDXID: `SPDXRef-BundledFile-${componentIndex + 1}-${fileIndex + 1}`,
        owner,
        fileName: file.fileName,
        checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256.toLowerCase() }],
        licenseConcluded: entry.licenseDeclared,
        licenseInfoInFiles: [entry.licenseDeclared],
        copyrightText: 'NOASSERTION'
      }
    })
  })
  const fileEntries = files.concat(
    bundledFiles.map(
      ({ SPDXID, fileName, checksums, licenseConcluded, licenseInfoInFiles, copyrightText }) => ({
        SPDXID,
        fileName,
        checksums,
        licenseConcluded,
        licenseInfoInFiles,
        copyrightText
      })
    )
  )
  return {
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    name: `${manifest.name}-release-sbom`,
    documentNamespace: `https://spdx.org/spdxdocs/${manifest.name}-${manifest.version}-${created.replace(/[:.]/g, '-')}`,
    creationInfo: { created, creators: ['Tool: Ola packaged dependency inventory'] },
    comment:
      'Application archive dependency manifests, pinned bundled native binaries and release artifacts. Electron, the Node runtime and external system libraries require separate inventories; this document does not claim complete binary composition.',
    packages,
    files: fileEntries,
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: rootPackageId
      },
      ...packages.slice(1).map((dependency) => ({
        spdxElementId: rootPackageId,
        relationshipType: dependency.SPDXID.startsWith('SPDXRef-Bundled-')
          ? 'CONTAINS'
          : 'DEPENDS_ON',
        relatedSpdxElement: dependency.SPDXID
      })),
      ...files.map((artifact) => ({
        spdxElementId: rootPackageId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: artifact.SPDXID
      })),
      ...bundledFiles.map((file) => ({
        spdxElementId: file.owner,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: file.SPDXID
      }))
    ]
  }
}

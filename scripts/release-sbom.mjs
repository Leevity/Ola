/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native Node JavaScript uses JSDoc types. */
/** @typedef {{name: string, version: string}} ApplicationManifest */
/** @typedef {{name: string, versionInfo: string, path: string}} InstalledComponent */
/** @typedef {{name: string, sha256: string}} ReleaseArtifact */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const asar = createRequire(import.meta.url)('@electron/asar')
const packageManifestPath =
  /^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*package\.json$/

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
  const components = asar
    .listPackage(archivePath)
    .map((entry) => entry.replace(/^\//, ''))
    .filter((entry) => packageManifestPath.test(entry))
    .map((path) => {
      const data = JSON.parse(asar.extractFile(archivePath, path).toString('utf8'))
      if (
        typeof data.name !== 'string' ||
        !data.name ||
        typeof data.version !== 'string' ||
        !data.version
      ) {
        throw new Error(`Packaged dependency manifest lacks name/version: ${path}`)
      }
      return { name: data.name, versionInfo: data.version, path }
    })
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

/**
 * @param {ApplicationManifest} manifest
 * @param {InstalledComponent[]} components
 * @param {ReleaseArtifact[]} artifacts
 * @param {string} [created]
 */
export function createReleaseSbom(
  manifest,
  components,
  artifacts,
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
    }))
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
  return {
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    name: `${manifest.name}-release-sbom`,
    documentNamespace: `https://spdx.org/spdxdocs/${manifest.name}-${manifest.version}-${created.replace(/[:.]/g, '-')}`,
    creationInfo: { created, creators: ['Tool: Ola packaged dependency inventory'] },
    comment:
      'Application archive dependency manifests and release artifacts. Bundled code, Electron and external system libraries require separate inventories; this document does not claim complete binary composition.',
    packages,
    files,
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: rootPackageId
      },
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
  }
}

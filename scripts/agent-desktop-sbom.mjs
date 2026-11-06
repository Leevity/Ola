/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Turn the agent-desktop supply lock into SPDX inventory entries.
 *
 * `release-sbom.mjs` inventories the dependency manifests inside the archive, which say nothing
 * about the bare executables staged beside it. The accessibility CLI is third-party native code
 * downloaded at build time, so it has to appear in the release SBOM with the checksums the build
 * pinned, or the document silently claims the app contains only npm packages.
 */
import { readAgentDesktopLock } from './stage-agent-desktop.mjs'

const SHA256 = /^[a-f0-9]{64}$/i

/**
 * @param {string} [lockPath]
 * @returns {Promise<{name: string, versionInfo: string, licenseDeclared: string,
 *          downloadLocation: string, source: string, files: {fileName: string, sha256: string, size: number}[]}>}
 */
export async function bundledBinaryComponents(lockPath) {
  const lock = await readAgentDesktopLock(lockPath)
  if (typeof lock.name !== 'string' || !lock.name) {
    throw new Error('agent-desktop lock must name the component')
  }
  if (typeof lock.version !== 'string' || !lock.version) {
    throw new Error('agent-desktop lock must pin a version')
  }
  if (typeof lock.license !== 'string' || !lock.license) {
    throw new Error('agent-desktop lock must name a license')
  }
  if (typeof lock.checksumsSha256 !== 'string' || !SHA256.test(lock.checksumsSha256)) {
    throw new Error('agent-desktop lock must pin the sha256 of its upstream checksums file')
  }
  const files = []
  for (const [key, entry] of Object.entries(lock.platforms)) {
    if (!SHA256.test(entry.sha256))
      throw new Error(`agent-desktop ${key} archive sha256 is invalid`)
    for (const [name, pin] of Object.entries(entry.binaries)) {
      if (!SHA256.test(pin.sha256))
        throw new Error(`agent-desktop ${key}/${name} sha256 is invalid`)
      if (!Number.isInteger(pin.size) || pin.size <= 0) {
        throw new Error(`agent-desktop ${key}/${name} size is invalid`)
      }
      files.push({
        fileName: `./resources/agent-desktop/${key}/${name}`,
        sha256: pin.sha256.toLowerCase(),
        size: pin.size
      })
    }
  }
  if (files.length === 0) throw new Error('agent-desktop lock pins no binaries')
  return {
    name: lock.name,
    versionInfo: lock.version,
    licenseDeclared: lock.license,
    downloadLocation: lock.archiveBaseUrl,
    source: 'resources/agent-desktop.lock.json',
    checksumsFile: `${lock.archiveBaseUrl}/${lock.checksumsFile}`,
    checksumsSha256: lock.checksumsSha256,
    repository: lock.repository,
    files
  }
}

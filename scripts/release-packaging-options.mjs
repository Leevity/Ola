/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native Node JavaScript helper. */
/** @param {'mac'|'win'|'linux'} platform @param {boolean} directoryOnly @param {boolean} unsigned */
export function releaseTargets(platform, directoryOnly, unsigned) {
  if (directoryOnly) return ['--dir']
  if (platform === 'mac') return unsigned ? ['zip'] : ['dmg', 'zip']
  if (platform === 'win') return ['nsis', 'zip']
  if (platform === 'linux') return ['AppImage', 'deb']
  throw new Error('Unsupported release platform')
}

/** @param {string} platform @param {string} arch @param {NodeJS.ProcessEnv} environment */
export function releaseBuilderEnvironment(platform, arch, environment) {
  return {
    ...environment,
    NODE_OPTIONS: '--max-old-space-size=4096',
    // Pin classic BCJ for legacy NSIS decoder compatibility on ARM64 payloads.
    // Use the reversible classic filter for ARM64 payloads; retain differential packages.
    ...(platform === 'win' && arch === 'arm64' ? { ELECTRON_BUILDER_7Z_FILTER: 'BCJ' } : {})
  }
}

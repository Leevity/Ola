const forbiddenNames = [
  /^Ola\.Native\.Worker(?:\.exe)?$/i,
  /^Ola\.CodeGraph\.Worker(?:\.exe)?$/i,
  /^Ola\.(?:Native|CodeGraph|Worker)\.[^/]*\.dll$/i,
  /\.runtimeconfig\.json$/i,
  /\.deps\.json$/i,
  /^hostfxr(?:\.dll|\.so|\.dylib)?$/i,
  /^hostpolicy(?:\.dll|\.so|\.dylib)?$/i
]

export function isLegacyRuntimeArtifactPath(candidate) {
  const segments = candidate.replaceAll('\\', '/').split('/').filter(Boolean)
  if (segments.some((segment) => segment.toLowerCase() === 'native-worker')) return true
  return forbiddenNames.some((pattern) => pattern.test(segments.at(-1) ?? ''))
}

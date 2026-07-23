import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const builder = await readFile('electron-builder.yml', 'utf8')
const workflow = await readFile('.github/workflows/build.yml', 'utf8')
const packageJson = await readFile('package.json', 'utf8')
const verifier = await readFile('scripts/verify-release-artifacts.mjs', 'utf8')

assert.match(builder, /hardenedRuntime: true/)
assert.match(builder, /notarize: true/)
assert.doesNotMatch(workflow, /release:\n\s+types: \[published\]/)
assert.match(workflow, /从 draft Release 开始构建/)
assert.match(workflow, /publish-release:/)
assert.match(workflow, /if: inputs\.publish == true/)
assert.match(workflow, /Publish verified draft Release/)
assert.match(workflow, /run: npm run build/)
assert.match(workflow, /Refusing to modify an already published Release/)
assert.match(workflow, /Release signing credentials are required/)
assert.match(workflow, /Smoke install Windows release artifact/)
assert.match(workflow, /Smoke extract Linux release artifact/)
assert.match(workflow, /Smoke mount macOS release artifact/)
assert.match(workflow, /WIN_CSC_LINK/)
assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/)
assert.match(workflow, /Require macOS signing and notarization credentials for published releases/)
assert.match(workflow, /OLA_RELEASE_REQUIRED: \$\{\{ inputs\.publish && 'true' \|\| 'false' \}\}/)
assert.match(workflow, /verify-release-artifacts\.mjs --platform win/)
assert.match(workflow, /verify-release-artifacts\.mjs --platform linux/)
assert.match(workflow, /verify-release-artifacts\.mjs --platform mac/)
assert.match(workflow, /release-assets\/SHA256SUMS-\*\.txt/)
assert.match(
  workflow,
  /--checksums release-assets\/SHA256SUMS-win-\$\{\{ matrix\.artifact_arch \}\}\.txt/
)
assert.match(
  workflow,
  /--checksums release-assets\/SHA256SUMS-linux-\$\{\{ matrix\.artifact_arch \}\}\.txt/
)
assert.match(
  workflow,
  /--checksums release-assets\/SHA256SUMS-mac-\$\{\{ matrix\.artifact_arch \}\}\.txt/
)
assert.match(workflow, /release-assets\/\*\.spdx\.json/)
assert.match(verifier, /spdxVersion: 'SPDX-2\.3'/)
assert.match(verifier, /SPDXRef-Artifact-/)
assert.match(verifier, /relationshipType: 'CONTAINS'/)
assert.match(verifier, /algorithm: 'SHA256'/)
assert.match(verifier, /Get-AuthenticodeSignature/)
assert.match(verifier, /codesign/)
assert.match(verifier, /context:primary-signature/)
assert.match(workflow, /Start-Process -FilePath \$installer\.FullName/)
assert.match(workflow, /dpkg-deb --extract/)
assert.match(workflow, /hdiutil attach/)
assert.match(workflow, /gh release edit "\$\{publish_args\[@\]\}"/)
assert.match(verifier, /macOS release assets must include both dmg and zip packages/)
assert.match(verifier, /--checksums/)
assert.match(verifier, /!file\.endsWith\('\.spdx\.json'\)/)
assert.match(packageJson, /"verify:release-gates"/)
assert.match(packageJson, /npm run verify:release-gates/)

console.log('release gates verification passed')

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/Extensions/ExtensionManagementStore.cs',
  'utf8'
)

assert.match(source, /InstallDirectoryAtomically\(sourcePath, targetPath\)/)
assert.match(source, /catch\s*\{\s*DeleteDirectoryIfExists\(targetPath\);\s*throw;/s)
assert.match(source, /ReplaceDirectoryAtomically\(sourceDir, targetDir\)/)
assert.match(
  source,
  /CopyDirectory\(sourceDir, stagingDir\);\s*Directory\.Move\(stagingDir, targetDir\);/s
)
assert.match(source, /Directory\.Move\(targetDir, backupDir\);\s*movedExisting = true;/s)
assert.match(source, /Directory\.Move\(stagingDir, targetDir\);\s*installedReplacement = true;/s)
assert.match(source, /Directory\.Move\(backupDir, targetDir\);/)
assert.doesNotMatch(source, /private static void ReplaceDirectory\(/)

console.log('extension directory atomicity verification passed')

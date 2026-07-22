import { resolve } from 'node:path'
import { loadGrammarManifest, resolveGrammarFiles } from './codegraph-grammar-manifest.mjs'

try {
  const manifest = loadGrammarManifest()
  const sourceDir = process.argv[2]
  const rid = process.argv[3]
  if ((sourceDir && !rid) || (!sourceDir && rid)) {
    throw new Error('usage: node scripts/validate-codegraph-grammars.mjs [source-directory rid]')
  }
  if (sourceDir) {
    const files = resolveGrammarFiles(resolve(sourceDir), rid, manifest)
    console.log(`[validate-codegraph-grammars] ${rid}: ${files.length} libraries are present`)
  } else {
    console.log(
      `[validate-codegraph-grammars] manifest is valid (${manifest.grammars.length} grammar libraries)`
    )
  }
} catch (error) {
  console.error(`[validate-codegraph-grammars] ${error?.message ?? error}`)
  process.exitCode = 1
}

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isBuiltin } from 'node:module'

const requirePattern = /(?:[\w$]*require[\w$]*|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function collectOutputFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectOutputFiles(entryPath)))
    else if (/\.(?:cjs|js|mjs)$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

export async function collectRuntimeMainDependencies(root, packageJson, explicitDependencies) {
  const runtimeDependencies = new Set(explicitDependencies)
  const outputFiles = await collectOutputFiles(join(root, 'out/main'))

  for (const file of outputFiles) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(requirePattern)) {
      const specifier = match[2]
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('#') ||
        isAbsolute(specifier) ||
        isBuiltin(specifier) ||
        specifier === 'electron'
      ) {
        continue
      }
      runtimeDependencies.add(packageName(specifier))
    }
  }

  const dependencies = {}
  for (const name of [...runtimeDependencies].sort()) {
    const packagePath = join(root, 'node_modules', ...name.split('/'), 'package.json')
    let installedPackage
    try {
      installedPackage = JSON.parse(await readFile(packagePath, 'utf8'))
    } catch {
      throw new Error(`Main runtime dependency is not installed: ${name}`)
    }
    const declaredVersion =
      packageJson.dependencies?.[name] ??
      packageJson.optionalDependencies?.[name] ??
      packageJson.devDependencies?.[name]
    dependencies[name] = declaredVersion ?? installedPackage.version
  }

  return dependencies
}

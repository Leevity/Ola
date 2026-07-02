#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const skillRoot = path.resolve(path.dirname(scriptPath), '..')
const templateRoot = path.join(skillRoot, 'templates', 'prototype')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const [key, inlineValue] = item.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      args[key] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

function slugify(value) {
  return (
    String(value || 'design-prototype')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'design-prototype'
  )
}

function ensureEmptyDirectory(dest) {
  if (existsSync(dest) && statSync(dest).isFile()) {
    throw new Error(`Destination exists and is not a directory: ${dest}`)
  }
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new Error(`Destination exists and is not empty: ${dest}`)
  }
  mkdirSync(dest, { recursive: true })
}

function updatePackageName(dest) {
  const packagePath = path.join(dest, 'package.json')
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  pkg.name = slugify(path.basename(dest))
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dest = path.resolve(String(args.dest || args.root || 'design-prototype'))

  if (!existsSync(templateRoot)) {
    throw new Error(`Prototype template is missing: ${templateRoot}`)
  }

  ensureEmptyDirectory(dest)
  cpSync(templateRoot, dest, {
    recursive: true,
    force: true,
    filter(current) {
      return !['node_modules', 'dist', '.vite', '.npm-cache', '.DS_Store'].includes(
        path.basename(current)
      )
    }
  })
  updatePackageName(dest)
  writeFileSync(
    path.join(dest, '.npmrc'),
    `cache=${path.join(dest, '.npm-cache')}\nfund=false\naudit=false\n`,
    'utf8'
  )
  console.log(JSON.stringify({ status: 'created', root: dest }, null, 2))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

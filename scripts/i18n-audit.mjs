/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const localesRoot = path.join(root, 'src', 'renderer', 'src', 'locales')

function flatten(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flatten(child, next)
      : [next]
  })
}

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
}
const defaultLocale = await readJson(path.join(localesRoot, 'en', 'settings.json'))
const expected = new Set(flatten(defaultLocale))
const localeEntries = (
  await import('node:fs/promises').then(({ readdir }) =>
    readdir(localesRoot, { withFileTypes: true })
  )
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const report = {}

for (const locale of localeEntries) {
  const file = path.join(localesRoot, locale, 'settings.json')
  try {
    const values = await readJson(file)
    const actual = new Set(flatten(values))
    report[locale] = [...expected].filter((key) => !actual.has(key))
  } catch {
    report[locale] = [...expected]
  }
}

const missing = Object.fromEntries(Object.entries(report).filter(([, keys]) => keys.length > 0))
const missingCounts = Object.fromEntries(
  Object.entries(missing).map(([locale, keys]) => [locale, keys.length])
)
const strict = process.argv.includes('--strict')
console.log(
  JSON.stringify(
    {
      expectedKeys: expected.size,
      locales: localeEntries.length,
      fallbackLocales: missingCounts,
      strict
    },
    null,
    2
  )
)
if (strict && Object.keys(missing).length > 0) {
  console.error('Strict i18n audit failed: one or more locales are missing fallback keys.')
  process.exitCode = 1
}

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const localesRoot = path.join(root, 'src', 'renderer', 'src', 'locales')
const rendererRoot = path.join(root, 'src', 'renderer', 'src')
const strict = process.argv.includes('--strict')

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

const localeEntries = (await readdir(localesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const namespaces = (await readdir(path.join(localesRoot, 'en')))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))

// ── 1. Every locale must translate every settings key (the surface users configure) ──
const settingsExpected = new Set(
  flatten(await readJson(path.join(localesRoot, 'en', 'settings.json')))
)
const settingsFallbacks = {}
for (const locale of localeEntries) {
  try {
    const actual = new Set(flatten(await readJson(path.join(localesRoot, locale, 'settings.json'))))
    settingsFallbacks[locale] = [...settingsExpected].filter((key) => !actual.has(key))
  } catch {
    settingsFallbacks[locale] = [...settingsExpected]
  }
}

// ── 2. Coverage per namespace, so partial translations stay visible but allowed ──
// Partial coverage is a product decision (untranslated strings fall back to English).
// It is reported, never enforced; the enforced rule is the one below.
const coverage = {}
for (const namespace of namespaces) {
  const expected = new Set(
    flatten(await readJson(path.join(localesRoot, 'en', `${namespace}.json`)))
  )
  const perLocale = {}
  for (const locale of localeEntries) {
    if (locale === 'en') continue
    try {
      const actual = new Set(
        flatten(await readJson(path.join(localesRoot, locale, `${namespace}.json`)))
      )
      const missing = [...expected].filter((key) => !actual.has(key)).length
      if (missing > 0) perLocale[locale] = missing
    } catch {
      perLocale[locale] = expected.size
    }
  }
  coverage[namespace] = { expectedKeys: expected.size, missing: perLocale }
}

// ── 3. Every literal t('...') key used by the Renderer must exist in the en catalog ──
// This is the class of bug a translation-completeness check cannot see: a key the
// code asks for that no catalog defines renders as the raw key in every language.
async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'locales') continue
      files.push(...(await sourceFiles(file)))
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(file)
    }
  }
  return files
}

const catalogs = new Map()
for (const namespace of namespaces) {
  const keys = flatten(await readJson(path.join(localesRoot, 'en', `${namespace}.json`)))
  catalogs.set(namespace, new Set(keys))
}

// i18next stores plurals as `<key>_one` / `<key>_other`, so a `t('x.count', { count })`
// call resolves through the suffixed entries rather than `x.count` itself.
function hasKey(namespace, key) {
  const catalog = catalogs.get(namespace)
  if (!catalog) return false
  return catalog.has(key) || catalog.has(`${key}_one`) || catalog.has(`${key}_other`)
}

const IDENT = /[A-Za-z0-9_$]/
const QUOTES = new Set(["'", '"', '`'])

// Returns the argument text of the call whose `(` sits at `openIndex`, or null when the
// call is unterminated. Strings and template literals are skipped so parentheses inside
// them do not shift the nesting depth.
function readArguments(source, openIndex) {
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (QUOTES.has(char)) quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
  return null
}

// Reads the leading string literal of an argument list. A template literal with an
// interpolation (`login:messages.${key}`) cannot be resolved statically and is reported
// as dynamic instead of guessed at.
function readFirstArgument(args) {
  let cursor = 0
  while (cursor < args.length && /\s/.test(args[cursor])) cursor += 1
  const quote = args[cursor]
  if (!QUOTES.has(quote)) return { dynamic: false, key: null }
  let value = ''
  for (cursor += 1; cursor < args.length; cursor += 1) {
    const char = args[cursor]
    if (char === '\\') {
      value += args[cursor + 1]
      cursor += 1
      continue
    }
    if (char === quote) {
      return { dynamic: quote === '`' && value.includes('${'), key: value }
    }
    if (quote === '`' && char === '$' && args[cursor + 1] === '{') {
      return { dynamic: true, key: value }
    }
    value += char
  }
  return { dynamic: false, key: null }
}

const USE_TRANSLATION = /useTranslation\(\s*/g
const NAMESPACE_LITERAL = /['"]([\w-]+)['"]/g
const NS_OPTION = /ns:\s*['"]([\w-]+)['"]/
const KEY_PREFIX = /keyPrefix:\s*['"]([\w.-]+)['"]/

// Some modules wrap i18next in a local helper, e.g.
//   function t(key: string) { return i18n.t(`login:messages.${key}`) }
// and then call `t('opened')`. The literal is a suffix of the real key, so the scan has to
// prefix it back before looking the key up.
const LOCAL_T_DECLARATION = /\b(?:function\s+t\s*\(|(?:const|let|var)\s+t\s*=)/
const WRAPPER_PREFIX = /i18n\s*\.\s*t\(\s*`([^`$]*)\$\{/g

// Splits an argument list on its top-level commas, ignoring commas inside strings and
// nested calls, so `useTranslation('chat', { keyPrefix: 'git' })` yields two arguments.
function splitArguments(args) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (QUOTES.has(char)) quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(args.slice(start, index))
      start = index + 1
    }
  }
  parts.push(args.slice(start))
  return parts
}

// A component may call `useTranslation` several times for different namespaces, so the
// file-level set is the union; a key found under any of them resolves at runtime. A hook
// called without an argument falls back to the default namespace, `common`.
function collectHookNamespaces(source) {
  const declared = new Set()
  const prefixes = new Set()
  for (const match of source.matchAll(USE_TRANSLATION)) {
    const args = readArguments(source, match.index + match[0].length - 1)
    if (args === null) continue
    const [first = '', ...rest] = splitArguments(args)
    const literals = [...first.matchAll(NAMESPACE_LITERAL)]
    // `useTranslation()` without an argument falls back to `common`. A module with no hook
    // at all (it receives `t` as a parameter) must stay out of `declared`, so the scan falls
    // back to the whole catalog instead of pinning its keys to `common`.
    if (literals.length === 0 && first.trim() === '') declared.add('common')
    for (const literal of literals) declared.add(literal[1])
    const prefix = KEY_PREFIX.exec(rest.join(','))?.[1]
    if (prefix) prefixes.add(prefix)
  }
  return { declared: [...declared], prefixes: [...prefixes] }
}

const unresolved = []
const dynamicKeys = []

// A local `t` wrapper turns `t('opened')` into `login:messages.opened`. Only modules that
// declare their own `t` can be affected; elsewhere `t` comes from the hook and the literal
// is the full key.
function collectWrapperPrefixes(source) {
  if (!LOCAL_T_DECLARATION.test(source)) return []
  return [...source.matchAll(WRAPPER_PREFIX)].map((match) => match[1])
}

for (const file of await sourceFiles(rendererRoot)) {
  const source = await readFile(file, 'utf8')
  if (!/\bt\s*\(/.test(source)) continue
  const { declared, prefixes } = collectHookNamespaces(source)
  const wrapperPrefixes = collectWrapperPrefixes(source)

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 't') continue
    if (index > 0 && IDENT.test(source[index - 1])) continue
    let cursor = index + 1
    while (cursor < source.length && /[ \t]/.test(source[cursor])) cursor += 1
    if (source[cursor] !== '(') continue
    const args = readArguments(source, cursor)
    if (args === null) continue
    const { dynamic, key: rawKey } = readFirstArgument(args)
    const line = source.slice(0, index).split(/\r?\n/).length
    if (dynamic) {
      dynamicKeys.push({ file: path.relative(root, file), line, key: rawKey ?? '<template>' })
      continue
    }
    if (!rawKey) continue

    const optionText = args.slice(args.indexOf(',') + 1)
    const explicitNamespace = NS_OPTION.exec(optionText)?.[1]
    const inlineColon = rawKey.indexOf(':')
    const inlineNamespace = inlineColon === -1 ? null : rawKey.slice(0, inlineColon)
    const key = inlineColon === -1 ? rawKey : rawKey.slice(inlineColon + 1)

    // Candidates, in runtime order: an inline `ns:key`, an explicit `{ ns }` option, then
    // every namespace the file's hooks declare. A module that takes `t` as a parameter has
    // no hook of its own, so its keys are resolved against the whole catalog set.
    const candidates = inlineNamespace
      ? [inlineNamespace]
      : explicitNamespace
        ? [explicitNamespace]
        : declared.length > 0
          ? declared
          : namespaces
    // Alternate spellings of the same call: `keyPrefix` prepends inside the namespace, a
    // local `t` wrapper prepends a literal that may itself carry `ns:`.
    const variants = [{ namespace: null, key }]
    for (const prefix of prefixes) variants.push({ namespace: null, key: `${prefix}.${key}` })
    for (const prefix of wrapperPrefixes) {
      const full = `${prefix}${key}`
      const colon = full.indexOf(':')
      variants.push(
        colon === -1
          ? { namespace: null, key: full }
          : { namespace: full.slice(0, colon), key: full.slice(colon + 1) }
      )
    }
    const resolved = variants.some(({ namespace, key: variant }) =>
      namespace ? hasKey(namespace, variant) : candidates.some((name) => hasKey(name, variant))
    )
    if (resolved) continue
    unresolved.push({
      file: path.relative(root, file),
      line,
      key: rawKey,
      namespaces: candidates.join('|')
    })
  }
}

const settingsMissing = Object.fromEntries(
  Object.entries(settingsFallbacks).filter(([, keys]) => keys.length > 0)
)
console.log(
  JSON.stringify(
    {
      expectedKeys: settingsExpected.size,
      locales: localeEntries.length,
      fallbackLocales: Object.fromEntries(
        Object.entries(settingsMissing).map(([locale, keys]) => [locale, keys.length])
      ),
      namespaceCoverage: coverage,
      unresolvedKeys: unresolved,
      dynamicKeys: dynamicKeys.length,
      strict
    },
    null,
    2
  )
)

if (strict && Object.keys(settingsMissing).length > 0) {
  console.error('Strict i18n audit failed: one or more locales are missing settings keys.')
  process.exitCode = 1
}
if (strict && unresolved.length > 0) {
  console.error(
    `Strict i18n audit failed: ${unresolved.length} key(s) used by the Renderer are absent from the en catalogs.`
  )
  process.exitCode = 1
}

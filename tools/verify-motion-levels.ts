import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const tokens = await readFile('packages/ola-design/tokens.json', 'utf8')
const sync = await readFile('scripts/sync-ola-design.mjs', 'utf8')
const motionLevel = await readFile('src/renderer/src/lib/motion-level.ts', 'utf8')
const hook = await readFile('src/renderer/src/hooks/use-motion-level.ts', 'utf8')
const store = await readFile('src/renderer/src/stores/settings-store.ts', 'utf8')
const transitions = await readFile('src/renderer/src/components/animate-ui/transitions.tsx', 'utf8')
const collapsible = await readFile(
  'src/renderer/src/components/chat/CollapsibleHeightPanel.tsx',
  'utf8'
)
const runtimeSync = await readFile('src/renderer/src/components/theme-runtime-sync.tsx', 'utf8')
const mainCss = await readFile('src/renderer/src/assets/main.css', 'utf8')
const settingsPage = await readFile('src/renderer/src/components/settings/SettingsPage.tsx', 'utf8')
const generatedCss = await readFile('src/renderer/src/assets/ola-design-tokens.css', 'utf8')
const generatedTs = await readFile('src/renderer/src/lib/ola-design-tokens.ts', 'utf8')
const packageJson = await readFile('package.json', 'utf8')

// ── The ladder has one owner: the design tokens ──
assert.match(
  tokens,
  /"levels": \["full", "reduced", "off"\]/,
  'design tokens must declare the three-level motion ladder'
)
assert.match(
  sync,
  /motionLevels\[0\] !== 'full' \|\|\s*motionLevels\[1\] !== 'reduced' \|\|\s*motionLevels\[2\] !== 'off'/,
  'sync-ola-design must pin the ladder order'
)
assert.match(
  generatedTs,
  /levels: \['full', 'reduced', 'off'\]/,
  'the generated TS tokens must carry the ladder'
)
assert.match(generatedCss, /--ola-motion-feedback: \d+ms/, 'feedback duration must be generated')
assert.match(
  generatedCss,
  /--ola-motion-transition: \d+ms/,
  'transition duration must be generated'
)

// ── One ladder definition in the Renderer, checked against the tokens at test time ──
assert.match(motionLevel, /export const MOTION_LEVELS = \['full', 'reduced', 'off'\] as const/)
assert.match(motionLevel, /export function isMotionLevel\(/)
assert.match(motionLevel, /export function normalizeMotionLevel\(/)
assert.match(motionLevel, /if \(preferred === 'off'\) return 'off'/)
assert.match(motionLevel, /if \(systemPrefersReduced\) return 'reduced'/)
assert.match(motionLevel, /export function getMotionProfile\(/)
assert.match(motionLevel, /transitionMs: feedback/)

// ── The hook is the only place that reads the preference ──
assert.match(hook, /useReducedMotion/)
assert.match(hook, /useSettingsStore\(\(state\) => state\.motionLevel\)/)
assert.match(hook, /resolveMotionLevel\(stored, Boolean\(systemPrefersReduced\)\)/)
assert.match(hook, /export function useMotionProfile\(\)/)

// ── Store: a persisted ladder value, migrated off the old boolean ──
assert.match(store, /motionLevel: MotionLevel/, 'the store must type motionLevel as the ladder')
assert.match(store, /motionLevel: DEFAULT_MOTION_LEVEL/, 'the store needs a ladder default')
assert.match(
  store,
  /state\.animationsEnabled === false \? 'off' : normalizeMotionLevel\(state\.motionLevel\)/,
  'the legacy boolean must fold into the ladder during migration'
)
assert.match(store, /delete state\.animationsEnabled/, 'the retired boolean must not persist')
assert.match(store, /version: 30/, 'the settings schema version must move with the migration')
assert.doesNotMatch(
  store,
  /animationsEnabled: state\.animationsEnabled/,
  'the retired boolean must not be partialized'
)

// ── Motion consumers all read the profile, never the boolean ──
for (const [name, source] of [
  ['animate-ui/transitions.tsx', transitions],
  ['CollapsibleHeightPanel.tsx', collapsible]
]) {
  assert.match(source, /useMotionProfile\(\)/, `${name} must read the motion profile`)
  assert.doesNotMatch(source, /animationsEnabled/, `${name} must not read the retired boolean`)
}
assert.match(transitions, /!profile\.opacity/, 'PanelTransition must go static at off')
assert.match(collapsible, /enabled && profile\.transform/, 'height motion must require transforms')
assert.match(
  collapsible,
  /enabled && profile\.opacity/,
  'reduced motion must still be able to fade'
)
assert.match(
  collapsible,
  /canAnimate \? duration : canFade \? fadeSeconds : 0/,
  'collapsible timing must follow the ladder'
)

// ── data attributes are the CSS contract for the same ladder ──
assert.match(runtimeSync, /root\.dataset\.motionLevel = motionLevel/)
assert.match(runtimeSync, /motionLevel === 'off' \? 'disabled' : 'enabled'/)
assert.match(
  mainCss,
  /:root\[data-motion-level='reduced'\] \*/,
  'reduced motion needs a CSS rule that keeps fades only'
)
assert.match(
  mainCss,
  /transition-duration: var\(--ola-motion-feedback\) !important/,
  'the reduced rule must use the generated feedback duration'
)
assert.doesNotMatch(
  mainCss,
  /transition: background 0\.2s;/,
  'literal durations must come from the generated motion tokens'
)

// ── The settings page offers all three levels and resets to the default ──
assert.match(settingsPage, /\{MOTION_LEVELS\.map\(\(level\) =>/)
assert.match(settingsPage, /role="radio"/)
assert.match(settingsPage, /settings\.updateSettings\(\{ motionLevel: level \}\)/)
assert.match(settingsPage, /motionLevel: DEFAULT_MOTION_LEVEL/)
assert.doesNotMatch(settingsPage, /animationsEnabled/, 'no settings control may use the boolean')

for (const locale of ['en', 'zh', 'de', 'ja']) {
  const catalog = await readFile(`src/renderer/src/locales/${locale}/settings.json`, 'utf8')
  assert.match(catalog, /"motionLevel"/, `${locale} needs the motion level label`)
  for (const level of ['full', 'reduced', 'off']) {
    assert.match(
      catalog,
      new RegExp(`"${level}": \\{\\s*"label"`),
      `${locale} is missing the ${level} motion label`
    )
  }
}

assert.match(packageJson, /"verify:motion-levels"/)
assert.match(packageJson, /npm run verify:motion-levels/)

console.log('Motion level verification passed')

import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// Every assertion here is about code, not layout, so the sources are read with
// whitespace collapsed. Collapsing turns a wrapped array into `[ 'full', … ]`,
// so patterns tolerate a space wherever the formatter may break a line.
const tokens = await readCollapsedSource('packages/ola-design/tokens.json')
const sync = await readCollapsedSource('scripts/sync-ola-design.mjs')
const motionLevel = await readCollapsedSource('src/renderer/src/lib/motion-level.ts')
const hook = await readCollapsedSource('src/renderer/src/hooks/use-motion-level.ts')
const store = await readCollapsedSource('src/renderer/src/stores/settings-store.ts')
const transitions = await readCollapsedSource(
  'src/renderer/src/components/animate-ui/transitions.tsx'
)
const collapsible = await readCollapsedSource(
  'src/renderer/src/components/chat/CollapsibleHeightPanel.tsx'
)
const runtimeSync = await readCollapsedSource('src/renderer/src/components/theme-runtime-sync.tsx')
const mainCss = await readCollapsedSource('src/renderer/src/assets/main.css')
const settingsPage = await readCollapsedSource(
  'src/renderer/src/components/settings/SettingsPage.tsx'
)
const generatedCss = await readCollapsedSource('src/renderer/src/assets/ola-design-tokens.css')
const generatedTs = await readCollapsedSource('src/renderer/src/lib/ola-design-tokens.ts')
const packageJson = await readCollapsedSource('package.json')

// ── The ladder has one owner: the design tokens ──
assert.match(
  tokens,
  /"levels":\s*\[\s*"full",\s*"reduced",\s*"off"\s*\]/,
  'design tokens must declare the three-level motion ladder'
)
assert.match(
  sync,
  /motionLevels\[0\] !== 'full' \|\|\s*motionLevels\[1\] !== 'reduced' \|\|\s*motionLevels\[2\] !== 'off'/,
  'sync-ola-design must pin the ladder order'
)
assert.match(
  generatedTs,
  /levels:\s*\[\s*'full',\s*'reduced',\s*'off'\s*\]/,
  'the generated TS tokens must carry the ladder'
)
assert.match(generatedCss, /--ola-motion-feedback:\s*\d+ms/, 'feedback duration must be generated')
assert.match(
  generatedCss,
  /--ola-motion-transition:\s*\d+ms/,
  'transition duration must be generated'
)

// ── One ladder definition in the Renderer, checked against the tokens at test time ──
assert.match(
  motionLevel,
  /export const MOTION_LEVELS =\s*\[\s*'full',\s*'reduced',\s*'off'\s*\] as const/
)
assert.match(motionLevel, /export function isMotionLevel\(/)
assert.match(motionLevel, /export function normalizeMotionLevel\(/)
assert.match(motionLevel, /if \(\s*preferred === 'off'\s*\) return 'off'/)
assert.match(motionLevel, /if \(\s*systemPrefersReduced\s*\) return 'reduced'/)
assert.match(motionLevel, /export function getMotionProfile\(/)
assert.match(motionLevel, /transitionMs:\s*feedback/)

// ── The hook is the only place that reads the preference ──
assert.match(hook, /useReducedMotion/)
assert.match(hook, /useSettingsStore\(\s*\(state\) => state\.motionLevel\s*\)/)
assert.match(hook, /resolveMotionLevel\(\s*stored,\s*Boolean\(systemPrefersReduced\)\s*\)/)
assert.match(hook, /export function useMotionProfile\(\)/)

// ── Store: a persisted ladder value, migrated off the old boolean ──
assert.match(store, /motionLevel:\s*MotionLevel/, 'the store must type motionLevel as the ladder')
assert.match(store, /motionLevel:\s*DEFAULT_MOTION_LEVEL/, 'the store needs a ladder default')
assert.match(
  store,
  /state\.animationsEnabled === false \?\s*'off' :\s*normalizeMotionLevel\(state\.motionLevel\)/,
  'the legacy boolean must fold into the ladder during migration'
)
assert.match(store, /delete state\.animationsEnabled/, 'the retired boolean must not persist')
assert.match(store, /version:\s*30/, 'the settings schema version must move with the migration')
assert.doesNotMatch(
  store,
  /animationsEnabled:\s*state\.animationsEnabled/,
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
  /canAnimate \?\s*duration :\s*canFade \?\s*fadeSeconds :\s*0/,
  'collapsible timing must follow the ladder'
)

// ── data attributes are the CSS contract for the same ladder ──
assert.match(runtimeSync, /root\.dataset\.motionLevel = motionLevel/)
assert.match(runtimeSync, /motionLevel === 'off' \?\s*'disabled' :\s*'enabled'/)
assert.match(
  mainCss,
  /:root\[data-motion-level='reduced'\]\s*\*/,
  'reduced motion needs a CSS rule that keeps fades only'
)
assert.match(
  mainCss,
  /transition-duration:\s*var\(\s*--ola-motion-feedback\s*\)\s*!important/,
  'the reduced rule must use the generated feedback duration'
)
assert.doesNotMatch(
  mainCss,
  /transition:\s*background 0\.2s;/,
  'literal durations must come from the generated motion tokens'
)

// ── The settings page offers all three levels and resets to the default ──
assert.match(settingsPage, /\{MOTION_LEVELS\.map\(\s*\(level\) =>/)
assert.match(settingsPage, /role="radio"/)
assert.match(settingsPage, /settings\.updateSettings\(\s*\{\s*motionLevel:\s*level\s*\}\s*\)/)
assert.match(settingsPage, /motionLevel:\s*DEFAULT_MOTION_LEVEL/)
assert.doesNotMatch(settingsPage, /animationsEnabled/, 'no settings control may use the boolean')

for (const locale of ['en', 'zh', 'de', 'ja']) {
  const catalog = await readCollapsedSource(`src/renderer/src/locales/${locale}/settings.json`)
  assert.match(catalog, /"motionLevel"/, `${locale} needs the motion level label`)
  for (const level of ['full', 'reduced', 'off']) {
    assert.match(
      catalog,
      new RegExp(`"${level}":\\s*\\{\\s*"label"`),
      `${locale} is missing the ${level} motion label`
    )
  }
}

assert.match(packageJson, /"verify:motion-levels"/)
assert.match(packageJson, /npm run verify:motion-levels/)

console.log('Motion level verification passed')

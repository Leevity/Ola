import {
  DEFAULT_APP_THEME_PRESET,
  DEFAULT_SSH_TERMINAL_THEME_PRESET,
  isAppThemePreset,
  type AppThemePreset
} from './theme-presets'

export const DEFAULT_THEME_MODE = 'system' as const

/** Saved choices remain user preferences, including choices that once matched an old default. */
export function normalizeThemePreferences(state: Record<string, unknown>): {
  theme: 'light' | 'dark' | 'system'
  themePreset: AppThemePreset
  sshTerminalThemePreset: AppThemePreset
} {
  return {
    theme:
      state.theme === 'light' || state.theme === 'dark' || state.theme === 'system'
        ? state.theme
        : DEFAULT_THEME_MODE,
    themePreset: isAppThemePreset(state.themePreset) ? state.themePreset : DEFAULT_APP_THEME_PRESET,
    sshTerminalThemePreset: isAppThemePreset(state.sshTerminalThemePreset)
      ? state.sshTerminalThemePreset
      : DEFAULT_SSH_TERMINAL_THEME_PRESET
  }
}

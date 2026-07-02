export const SUPPORTED_LANGUAGE_CODES = [
  'en',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
  'ru',
  'ar',
  'it',
  'nl',
  'tr',
  'vi',
  'th',
  'id'
] as const

export type AppLanguage = (typeof SUPPORTED_LANGUAGE_CODES)[number]

const LANGUAGE_NATIVE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
  it: 'Italiano',
  nl: 'Nederlands',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia'
}

const LANGUAGE_ENGLISH_NAMES: Record<AppLanguage, string> = {
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  it: 'Italian',
  nl: 'Dutch',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian'
}

export interface LanguageOption {
  value: AppLanguage
  label: string
}

export const LANGUAGE_OPTIONS: LanguageOption[] = SUPPORTED_LANGUAGE_CODES.map((value) => ({
  value,
  label: LANGUAGE_NATIVE_LABELS[value]
}))

function normalizeLanguageTag(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-')
}

export function normalizeLanguageCode(value?: string | null): AppLanguage {
  const normalized = normalizeLanguageTag(value ?? '')
  if (!normalized) return 'en'

  for (const code of SUPPORTED_LANGUAGE_CODES) {
    if (normalized === code || normalized.startsWith(`${code}-`)) {
      return code
    }
  }

  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('ko')) return 'ko'
  if (normalized.startsWith('fr')) return 'fr'
  if (normalized.startsWith('de')) return 'de'
  if (normalized.startsWith('es')) return 'es'
  if (normalized.startsWith('pt')) return 'pt'
  if (normalized.startsWith('ru')) return 'ru'
  if (normalized.startsWith('ar')) return 'ar'
  if (normalized.startsWith('it')) return 'it'
  if (normalized.startsWith('nl')) return 'nl'
  if (normalized.startsWith('tr')) return 'tr'
  if (normalized.startsWith('vi')) return 'vi'
  if (normalized.startsWith('th')) return 'th'
  if (normalized.startsWith('id')) return 'id'

  return 'en'
}

export function detectSystemLanguage(): AppLanguage {
  if (typeof navigator === 'undefined') return 'en'
  return normalizeLanguageCode(navigator.language || navigator.languages?.[0] || 'en')
}

export function resolveIntlLocale(language?: string | null): string {
  const code = normalizeLanguageCode(language)
  if (code === 'en') return 'en-US'
  if (code === 'zh') return 'zh-CN'
  return code
}

export function resolveLanguageLabel(language?: string | null): string {
  return LANGUAGE_NATIVE_LABELS[normalizeLanguageCode(language)]
}

export function resolveLanguageName(language?: string | null): string {
  return LANGUAGE_ENGLISH_NAMES[normalizeLanguageCode(language)]
}

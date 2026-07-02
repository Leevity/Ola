import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { normalizeLanguageCode, SUPPORTED_LANGUAGE_CODES } from '@renderer/lib/i18n-language'

type LocaleNamespace = Record<string, unknown>
type LocaleResources = Record<string, Record<string, LocaleNamespace>>

const localeModules = import.meta.glob('./*/*.json', {
  eager: true,
  import: 'default'
}) as Record<string, LocaleNamespace>

const resources: LocaleResources = {}

for (const [path, namespaceContent] of Object.entries(localeModules)) {
  const match = path.match(/\.\/([^/]+)\/([^/]+)\.json$/)
  if (!match) continue

  const [, language, namespace] = match
  if (!resources[language]) {
    resources[language] = {}
  }

  resources[language][namespace] = namespaceContent
}

i18n.use(initReactI18next).init({
  resources,
  lng: normalizeLanguageCode(useSettingsStore.getState().language),
  supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
  fallbackLng: 'en',
  nonExplicitSupportedLngs: true,
  defaultNS: 'common',
  load: 'currentOnly',
  interpolation: {
    escapeValue: false
  }
})

export default i18n

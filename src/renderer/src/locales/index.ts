import i18n, { type BackendModule } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { normalizeLanguageCode, SUPPORTED_LANGUAGE_CODES } from '@renderer/lib/i18n-language'

type LocaleNamespace = Record<string, unknown>

// English is the fallback for every language, so it stays bundled. The other 15
// languages used to be eager too, which put ~3.6 MB of translations on first paint
// no matter which language was selected.
const fallbackModules = import.meta.glob('./en/*.json', {
  eager: true,
  import: 'default'
}) as Record<string, LocaleNamespace>

const lazyModules = import.meta.glob(['./*/*.json', '!./en/*.json'])

function namespacesFor(
  modules: Record<string, LocaleNamespace>,
  language: string
): Record<string, LocaleNamespace> {
  const namespaces: Record<string, LocaleNamespace> = {}
  for (const [path, content] of Object.entries(modules)) {
    const match = path.match(/\.\/([^/]+)\/([^/]+)\.json$/)
    if (!match || match[1] !== language) continue
    namespaces[match[2]] = content
  }
  return namespaces
}

const fallbackResources = namespacesFor(fallbackModules, 'en')

// Stores and tool handlers call i18n.t('chat:…') imperatively, outside React, so they
// cannot suspend on a namespace. Load every namespace of the active language up front
// and let callers await i18nReady; only the other 15 languages stay lazy.
const namespaces = Object.keys(fallbackResources)

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language, namespace, callback) => {
    const load = lazyModules[`./${language}/${namespace}.json`]
    if (!load) {
      callback(null, {})
      return
    }
    load()
      .then((mod) => callback(null, (mod as { default: LocaleNamespace }).default))
      .catch((error: unknown) => callback(error as Error, null))
  }
}

export const i18nReady: Promise<unknown> = i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    partialBundledLanguages: true,
    resources: { en: fallbackResources },
    ns: namespaces,
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

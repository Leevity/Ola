import { getConfigValue } from '../ipc/secure-key-store'

const APP_PLUGIN_CONFIG_KEY = 'ola-app-plugins'
const GLOBAL_PROJECT_ID = '__global__'

interface BrowserPolicy {
  enabled: boolean
  allowedDomains: string[]
  blockedDomains: string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeDomain(value: string): string | null {
  let candidate = value.trim().toLowerCase()
  if (!candidate) return null
  if (candidate.startsWith('*.')) candidate = candidate.slice(2)
  if (candidate.startsWith('.')) candidate = candidate.slice(1)
  try {
    candidate = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname
  } catch {
    candidate = candidate.split(/[/?#]/)[0]
  }
  return candidate.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '') || null
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'string') return []
    const domain = normalizeDomain(item)
    return domain ? [domain] : []
  })
}

function pluginList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : []
}

function configState(value: unknown): Record<string, unknown> | null {
  const outer = record(value)
  return record(outer?.state) ?? outer
}

export async function resolveBrowserPolicy(projectId?: string | null): Promise<BrowserPolicy> {
  const persisted = configState(await getConfigValue(APP_PLUGIN_CONFIG_KEY))
  const byProject = record(persisted?.pluginsByProject)
  const global = pluginList(byProject?.[GLOBAL_PROJECT_ID]).find(
    (plugin) => plugin.id === 'browser'
  )
  const override = projectId
    ? pluginList(byProject?.[projectId]).find((plugin) => plugin.id === 'browser')
    : undefined
  const plugin = { ...global, ...override }
  return {
    enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : true,
    allowedDomains: normalizeList(plugin.browserAllowedDomains),
    blockedDomains: normalizeList(plugin.browserBlockedDomains)
  }
}

function matches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export async function checkBrowserUrlAccess(
  value: string,
  projectId?: string | null
): Promise<{ allowed: boolean; reason?: string }> {
  let url: URL
  try {
    url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported protocol')
  } catch {
    return { allowed: false, reason: 'BROWSER_URL_INVALID' }
  }
  const policy = await resolveBrowserPolicy(projectId)
  if (!policy.enabled) return { allowed: false, reason: 'BROWSER_PLUGIN_DISABLED' }
  const hostname = url.hostname.toLowerCase()
  const blocked = policy.blockedDomains.find((domain) => matches(hostname, domain))
  if (blocked) return { allowed: false, reason: `BROWSER_DOMAIN_BLOCKED:${blocked}` }
  if (
    policy.allowedDomains.length &&
    !policy.allowedDomains.some((domain) => matches(hostname, domain))
  )
    return { allowed: false, reason: 'BROWSER_DOMAIN_NOT_ALLOWED' }
  return { allowed: true }
}

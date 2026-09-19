export const SOUL_MARKET_ORIGIN = 'https://skills.ola.shop'
export const SOUL_MARKET_API_ORIGIN = `${SOUL_MARKET_ORIGIN}/api/v1`

export interface SoulMarketItem {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
}

export interface SoulCategory {
  value: string
  label: string
}

export const SOUL_FALLBACK_CATEGORIES: SoulCategory[] = [
  ['assistant', 'Assistant'],
  ['workflow', 'Workflow'],
  ['coding', 'Coding'],
  ['writing', 'Writing'],
  ['research', 'Research'],
  ['roleplay', 'Roleplay'],
  ['business', 'Business'],
  ['learning', 'Learning']
].map(([value, label]) => ({ value, label }))

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function validateSoulDownloadUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.origin !== SOUL_MARKET_ORIGIN
  ) {
    throw new Error('SOUL download URL is not an allowed marketplace URL')
  }
  if (!url.pathname.startsWith('/api/v1/souls/'))
    throw new Error('SOUL download URL is not allowed')
  return url
}

export function normalizeSoulMarketResponse(value: unknown): {
  total: number
  souls: SoulMarketItem[]
} {
  const root = record(value)
  if (root?.success === false) throw new Error('SOUL marketplace API returned failure')
  const data = root && Array.isArray(root.data) ? root.data : []
  const souls = data.map((value, index) => {
    const item = record(value) ?? {}
    const slug = text(item.slug) ?? text(item.name) ?? `soul-${index}`
    return {
      id: text(item.id) ?? slug,
      slug,
      name: text(item.name) ?? slug,
      description: text(item.description) ?? '',
      ...(text(item.category) ? { category: text(item.category) } : {}),
      downloads: number(item.downloads) ?? 0,
      ...(text(item.updatedAt) ? { updatedAt: text(item.updatedAt) } : {}),
      ...(text(item.filePath) ? { filePath: text(item.filePath) } : {}),
      url: `${SOUL_MARKET_ORIGIN}/souls/${encodeURIComponent(slug)}`,
      downloadUrl: `${SOUL_MARKET_API_ORIGIN}/souls/${encodeURIComponent(slug)}/download`
    }
  })
  return { total: number(root?.total) ?? souls.length, souls }
}

export function normalizeSoulCategories(value: unknown): SoulCategory[] {
  const root = record(value)
  if (root?.success === false || !Array.isArray(root?.data)) return SOUL_FALLBACK_CATEGORIES
  const categories = root.data.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ value: item.trim(), label: item.trim() }]
    const recordItem = record(item)
    const value = text(recordItem?.value) ?? text(recordItem?.slug) ?? text(recordItem?.name)
    return value
      ? [{ value, label: text(recordItem?.label) ?? text(recordItem?.name) ?? value }]
      : []
  })
  return categories.length ? categories : SOUL_FALLBACK_CATEGORIES
}

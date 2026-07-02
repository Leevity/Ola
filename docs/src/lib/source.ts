// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { docs as _docs } from 'fumadocs-mdx:collections/server'
import { type InferPageType, loader } from 'fumadocs-core/source'
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons'

// Virtual module types don't flow through TypeScript correctly; cast to any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docs = _docs as any

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()]
})

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, 'image.png']

  return {
    segments,
    url: `/og/docs/${segments.join('/')}`
  }
}

export async function getLLMText(page: InferPageType<typeof source>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processed = await (page.data as any).getText('processed')

  return `# ${(page.data as any).title}

${processed}`
}

import { source } from '@/lib/source'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { baseOptions, docsTabs } from '@/lib/layout.shared'

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      tabMode="top"
      sidebar={{
        tabs: docsTabs,
        defaultOpenLevel: 1,
        prefetch: false
      }}
    >
      {children}
    </DocsLayout>
  )
}

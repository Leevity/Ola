import { useEffect, useState } from 'react'

// Deliberately free of any mermaid import: chat renders this hook for every assistant
// message, so importing mermaid here would put the whole library on first paint.
// Rendering and export live in mermaid-runtime.ts, which is loaded on demand.
export function useMermaidThemeVersion(): number {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          setVersion((v) => v + 1)
          break
        }
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return version
}

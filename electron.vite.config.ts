import { resolve } from 'path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin, Rollup } from 'vite'

const productionRendererCsp =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; frame-src 'self' http://localhost:* http://127.0.0.1:*"

// Vite's development React refresh client needs inline module code. Keep that
// exception limited to the local dev server; packaged renderer HTML uses the
// strict production policy above.
const developmentRendererCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:5173; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https: wss: ws: http://localhost:* http://127.0.0.1:*; frame-src 'self' http://localhost:* http://127.0.0.1:*"

const rendererCspPlugin = {
  name: 'ola-renderer-csp',
  transformIndexHtml(html: string, context: { server?: unknown }): string {
    const policy = context.server ? developmentRendererCsp : productionRendererCsp
    return html.replace('__OLA_RENDERER_CSP__', policy)
  }
}

// The bundle budget gate needs Rollup's real module graph. Sniffing library names
// out of minified code reports locale strings and tokenizer vocabulary as hits.
// Written outside out/renderer so it never ships inside the packaged app.
const bundleManifestPlugin: Plugin = {
  name: 'ola-bundle-manifest',
  apply: 'build',
  writeBundle(_options, bundle) {
    const chunks = Object.values(bundle)
      .filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
      .map((chunk) => ({
        fileName: chunk.fileName,
        isEntry: chunk.isEntry,
        bytes: Buffer.byteLength(chunk.code, 'utf8'),
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        modules: Object.entries(chunk.modules).map(([id, mod]) => ({
          id,
          bytes: mod.renderedLength
        }))
      }))
    const target = resolve('out/bundle-manifest.json')
    mkdirSync(resolve('out'), { recursive: true })
    writeFileSync(target, JSON.stringify({ chunks }))
  }
}

export default defineConfig({
  main: {
    build: {
      minify: 'esbuild',
      rollupOptions: {
        external: ['better-sqlite3', '@jitsi/robotjs']
      }
    },
    assetsInclude: ['**/*.ico']
  },
  preload: {
    build: {
      minify: 'esbuild',
      isolatedEntries: true,
      externalizeDeps: false
    }
  },
  renderer: {
    // electron-vite defaults minify to false for all three targets, so the
    // shipped app was paying parse cost for unminified source.
    build: {
      minify: 'esbuild'
    },
    server: {
      port: 5173,
      strictPort: true
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'i18next',
        'react-i18next',
        'zustand',
        'immer',
        'clsx',
        'lucide-react',
        'sonner',
        'cmdk',
        'gpt-tokenizer',
        'nanoid',
        'class-variance-authority',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-search',
        'mermaid',
        'partial-json',
        'motion',
        'framer-motion'
      ],
      exclude: ['html-to-image']
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [rendererCspPlugin, bundleManifestPlugin, react(), tailwindcss()]
  }
})

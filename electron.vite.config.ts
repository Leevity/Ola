import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const productionRendererCsp =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; frame-src 'self' http://localhost:* http://127.0.0.1:*"

// Vite's development React refresh client needs inline module code. Keep that
// exception limited to the local dev server; packaged renderer HTML uses the
// strict production policy above.
const developmentRendererCsp =
  "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:5173; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; frame-src 'self' http://localhost:* http://127.0.0.1:*"

const rendererCspPlugin = {
  name: 'ola-renderer-csp',
  transformIndexHtml(html: string, context: { server?: unknown }): string {
    const policy = context.server ? developmentRendererCsp : productionRendererCsp
    return html.replace('__OLA_RENDERER_CSP__', policy)
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['better-sqlite3', '@jitsi/robotjs']
      }
    },
    assetsInclude: ['**/*.ico']
  },
  preload: {
    build: {
      isolatedEntries: true,
      externalizeDeps: false
    }
  },
  renderer: {
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
      exclude: ['@monaco-editor/react', '@monaco-editor/loader', 'html-to-image', 'monaco-editor']
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [rendererCspPlugin, react(), tailwindcss()]
  }
})

import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('tools/design-review'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
  server: {
    host: '127.0.0.1',
    port: 4323,
    strictPort: true,
    fs: { allow: [resolve('.')] }
  },
  build: { outDir: resolve('node_modules/.cache/ola-design-review'), emptyOutDir: true }
})

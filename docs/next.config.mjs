import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMDX } from 'fumadocs-mdx/next'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

const withMDX = createMDX({
  configPath: path.join(projectRoot, 'source.config.ts'),
  outDir: path.join(projectRoot, '.source')
})

const standaloneOutput =
  process.platform === 'win32'
    ? {}
    : {
        output: 'standalone',
        outputFileTracingRoot: projectRoot
      }

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  ...standaloneOutput,
  turbopack: {
    root: projectRoot
  },
  async rewrites() {
    return [
      {
        source: '/docs/:path*.mdx',
        destination: '/llms.mdx/docs/:path*'
      }
    ]
  },
  async redirects() {
    return [
      { source: '/docs/getting-started', destination: '/docs/start', permanent: false },
      {
        source: '/docs/getting-started/introduction',
        destination: '/docs/start',
        permanent: false
      },
      {
        source: '/docs/getting-started/installation',
        destination: '/docs/install',
        permanent: false
      },
      {
        source: '/docs/getting-started/quick-start',
        destination: '/docs/start/quick-start',
        permanent: false
      },
      {
        source: '/docs/getting-started/configuration',
        destination: '/docs/ops/configuration',
        permanent: false
      },
      { source: '/docs/plugins', destination: '/docs/channels', permanent: false },
      { source: '/docs/plugins/overview', destination: '/docs/channels', permanent: false },
      { source: '/docs/plugins/:path*', destination: '/docs/channels/:path*', permanent: false },
      { source: '/docs/providers', destination: '/docs/models', permanent: false },
      { source: '/docs/providers/overview', destination: '/docs/models', permanent: false },
      { source: '/docs/providers/:path*', destination: '/docs/models/:path*', permanent: false },
      {
        source: '/docs/core-concepts/agent-loop',
        destination: '/docs/agents/agent-loop',
        permanent: false
      },
      {
        source: '/docs/core-concepts/sessions',
        destination: '/docs/agents/sessions',
        permanent: false
      },
      {
        source: '/docs/core-concepts/context-compression',
        destination: '/docs/agents/context-compression',
        permanent: false
      },
      {
        source: '/docs/core-concepts/providers',
        destination: '/docs/models/provider-system',
        permanent: false
      },
      {
        source: '/docs/core-concepts/tool-system',
        destination: '/docs/capabilities/tools',
        permanent: false
      },
      {
        source: '/docs/features/chat-modes',
        destination: '/docs/capabilities/chat-modes',
        permanent: false
      },
      {
        source: '/docs/features/app-plugins',
        destination: '/docs/capabilities/app-plugins',
        permanent: false
      },
      {
        source: '/docs/features/plan-mode',
        destination: '/docs/capabilities/plan-mode',
        permanent: false
      },
      {
        source: '/docs/features/mcp-servers',
        destination: '/docs/capabilities/mcp-servers',
        permanent: false
      },
      {
        source: '/docs/features/file-preview',
        destination: '/docs/capabilities/file-preview',
        permanent: false
      },
      {
        source: '/docs/features/sub-agents',
        destination: '/docs/agents/sub-agents',
        permanent: false
      },
      {
        source: '/docs/features/agent-teams',
        destination: '/docs/agents/teams',
        permanent: false
      },
      {
        source: '/docs/features/skills-workflows',
        destination: '/docs/skills/workflows',
        permanent: false
      },
      {
        source: '/docs/features/cron-jobs',
        destination: '/docs/ops/cron-jobs',
        permanent: false
      },
      {
        source: '/docs/architecture/overview',
        destination: '/docs/reference/architecture',
        permanent: false
      },
      {
        source: '/docs/architecture/electron-model',
        destination: '/docs/platforms/electron-model',
        permanent: false
      },
      {
        source: '/docs/architecture/state-management',
        destination: '/docs/reference/state-management',
        permanent: false
      },
      {
        source: '/docs/architecture/database',
        destination: '/docs/ops/database',
        permanent: false
      },
      {
        source: '/docs/architecture/ipc-communication',
        destination: '/docs/reference/ipc-communication',
        permanent: false
      },
      {
        source: '/docs/development/setup',
        destination: '/docs/reference/development-setup',
        permanent: false
      },
      {
        source: '/docs/development/building',
        destination: '/docs/reference/building',
        permanent: false
      },
      {
        source: '/docs/development/contributing',
        destination: '/docs/reference/contributing',
        permanent: false
      }
    ]
  }
}

export default withMDX(config)

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Box, MessageSquare, Radio, Wrench } from 'lucide-react'

export const gitConfig = {
  user: 'Leevity',
  repo: 'Ola',
  branch: 'main'
}

export const docsTabs = [
  { title: 'Get started', url: '/docs/start' },
  { title: 'Install', url: '/docs/install' },
  { title: 'Channels', url: '/docs/channels' },
  { title: 'Agents', url: '/docs/agents' },
  { title: 'Capabilities', url: '/docs/capabilities' },
  { title: 'Skills', url: '/docs/skills' },
  { title: 'Models', url: '/docs/models' },
  { title: 'Platforms', url: '/docs/platforms' },
  { title: 'Ops', url: '/docs/ops' },
  { title: 'Reference', url: '/docs/reference' },
  { title: 'Help', url: '/docs/help' }
]

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-6 place-items-center rounded-md bg-cowork-red text-[11px] font-black text-white">
            OC
          </span>
          Ola
        </span>
      )
    },
    links: [
      {
        text: 'Releases',
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases`,
        secondary: true,
        icon: <Radio />
      },
      {
        text: 'Issues',
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}/issues`,
        secondary: true,
        icon: <MessageSquare />
      },
      {
        text: 'Skills',
        url: '/docs/skills',
        active: 'nested-url',
        icon: <Box />
      },
      {
        text: 'Reference',
        url: '/docs/reference',
        active: 'nested-url',
        icon: <Wrench />
      }
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`
  }
}

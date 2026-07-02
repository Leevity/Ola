'use client'

import Link from 'next/link'
import {
  ArrowRight,
  Bot,
  Braces,
  Github,
  MessageSquare,
  Network,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  Workflow
} from 'lucide-react'

const navCards = [
  {
    title: 'Get started',
    href: '/docs/start',
    desc: '安装、配置模型、绑定工作区，并跑通第一次本地 Agent 会话。',
    icon: Sparkles
  },
  {
    title: 'Channels',
    href: '/docs/channels',
    desc: '接入飞书、钉钉、企业微信、Telegram、Discord、QQ、微信和 WhatsApp。',
    icon: MessageSquare
  },
  {
    title: 'Agents',
    href: '/docs/agents',
    desc: '理解 Agent loop、sessions、sub-agents、teams 和上下文压缩。',
    icon: Bot
  }
]

const capabilityRows = [
  ['Tools', 'File I/O, code search, shell, browser, desktop, MCP'],
  ['Coordination', 'Sub-agents, team runtime, plans, goals, approvals'],
  ['Ops', 'Cron jobs, SQLite persistence, local config, notifications'],
  ['Channels', 'Workplace and community messaging integrations']
]

const docsLinks = [
  { title: 'Install', href: '/docs/install', icon: Terminal },
  { title: 'Capabilities', href: '/docs/capabilities', icon: Braces },
  { title: 'Skills', href: '/docs/skills', icon: Workflow },
  { title: 'Models', href: '/docs/models', icon: Radio },
  { title: 'Ops', href: '/docs/ops', icon: Timer },
  { title: 'Reference', href: '/docs/reference', icon: Network },
  { title: 'Help', href: '/docs/help', icon: ShieldCheck }
]

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0b0a0a] text-zinc-100">
      <section className="doc-noise relative border-b border-white/10">
        <div className="mx-auto grid min-h-[calc(100svh-64px)] max-w-7xl gap-8 px-4 py-14 md:grid-cols-[minmax(0,0.95fr)_minmax(420px,1.05fr)] md:items-center lg:px-8">
          <div className="max-w-2xl">
            <div className="home-reveal mb-8 inline-flex items-center gap-2 rounded-md border border-red-400/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200">
              <span className="size-1.5 rounded-full bg-red-400" />
              local-first multi-agent desktop
            </div>

            <h1 className="home-reveal home-reveal-delay-1 text-5xl font-black leading-none text-white sm:text-7xl lg:text-7xl 2xl:text-8xl">
              Open
              <span className="text-[#ff5a52]">Cowork</span>
            </h1>

            <p className="home-reveal home-reveal-delay-2 mt-6 max-w-xl text-base leading-8 text-zinc-400 sm:text-lg">
              一个让 AI Agent 在本地代码库里工作的桌面平台。它能读写文件、执行工具、调用
              MCP、组织子代理，并把结果送回你的工作消息平台。
            </p>

            <div className="home-reveal home-reveal-delay-3 mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/start"
                className="inline-flex items-center gap-2 rounded-md bg-[#ff5a52] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#ff6d66]"
              >
                Read the docs
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="https://github.com/Leevity/Ola"
                target="_blank"
                className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-zinc-100 transition hover:bg-white/10"
              >
                <Github className="size-4" />
                GitHub
              </Link>
            </div>

            <div className="home-reveal home-reveal-delay-3 mt-10 grid gap-3 sm:grid-cols-3">
              {navCards.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group rounded-lg border border-white/10 bg-black/30 p-4 transition hover:border-red-400/50 hover:bg-red-500/10"
                  >
                    <Icon className="mb-4 size-5 text-[#ff5a52]" />
                    <div className="text-sm font-semibold text-white">{item.title}</div>
                    <div className="mt-2 text-xs leading-5 text-zinc-500">{item.desc}</div>
                  </Link>
                )
              })}
            </div>
          </div>

          <div className="home-reveal home-reveal-delay-2 relative">
            <div className="doc-scanline overflow-hidden rounded-lg border border-white/10 bg-black terminal-panel">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-zinc-500">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#ff5a52]" />
                  <span className="size-2 rounded-full bg-zinc-600" />
                  <span className="size-2 rounded-full bg-zinc-600" />
                </div>
                <span>Ola workspace</span>
              </div>
              {/*
                TODO: replace with a real Ola product screenshot once one is captured.
                The upstream Ola screenshot has been removed; until a new one
                is added, the hero card is intentionally image-less.
              */}
              <div
                aria-label="Ola desktop interface (placeholder)"
                className="flex aspect-[16/10] w-full items-center justify-center rounded-md border border-dashed border-zinc-700 bg-zinc-900/40 text-sm text-zinc-500"
              >
                Ola desktop preview coming soon
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-white/10 bg-black/70 p-4 font-mono text-xs leading-6 text-zinc-400">
              <div>
                <span className="text-[#ff5a52]">$</span> npm run dev
              </div>
              <div>
                <span className="text-[#ff5a52]">agent</span> read files, search code, run tools,
                report back
              </div>
              <div className="text-zinc-600">main / preload / renderer / shared</div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-white/10 bg-[#0f0d0d]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <div>
            <p className="text-xs font-semibold uppercase text-[#ff5a52]">Documentation map</p>
            <h2 className="mt-3 text-3xl font-bold text-white">按工作方式组织，而不是按源码目录组织。</h2>
            <p className="mt-4 text-sm leading-7 text-zinc-400">
              顶栏是产品语义入口；左侧导航在每个栏目里按任务和对象分组；正文提供入口卡片、步骤和命令块，方便人和 AI 一起阅读。
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {docsLinks.map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex items-center justify-between rounded-lg border border-white/10 bg-black/30 p-4 text-sm text-zinc-300 transition hover:border-red-400/50 hover:text-white"
                >
                  <span className="inline-flex items-center gap-3">
                    <Icon className="size-4 text-[#ff5a52]" />
                    {item.title}
                  </span>
                  <ArrowRight className="size-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                </Link>
              )
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-8 px-4 py-14 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
        <div>
          <p className="text-xs font-semibold uppercase text-[#ff5a52]">Runtime surfaces</p>
          <h2 className="mt-3 text-3xl font-bold text-white">本地工具、消息渠道和 Agent 协作汇到同一个桌面运行时。</h2>
        </div>
        <div className="overflow-hidden rounded-lg border border-white/10">
          {capabilityRows.map(([name, value]) => (
            <div
              key={name}
              className="grid gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-4 text-sm last:border-b-0 sm:grid-cols-[180px_1fr]"
            >
              <div className="font-mono text-[#ff5a52]">{name}</div>
              <div className="text-zinc-400">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-white/10 bg-black">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <span>Ola documentation</span>
          <div className="flex flex-wrap gap-4">
            <Link className="inline-flex items-center gap-2 hover:text-white" href="/api/search">
              <Search className="size-4" />
              Search API
            </Link>
            <Link className="hover:text-white" href="/llms.txt">
              llms.txt
            </Link>
            <Link className="hover:text-white" href="/llms-full.txt">
              llms-full.txt
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}

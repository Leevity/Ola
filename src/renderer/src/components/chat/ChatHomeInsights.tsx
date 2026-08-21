import * as React from 'react'
import { ArrowUpRight, Clock3, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'

export function ChatHomeInsights(): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const sessions = useChatStore(
    useShallow((state) =>
      state.sessions
        .filter((session) => session.messageCount > 0)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 4)
    )
  )

  if (sessions.length === 0) return null

  return (
    <section className="mx-auto mt-8 w-full max-w-[760px]" aria-label="Recent conversations">
      <div className="mb-3 flex items-center justify-between px-1">
        <div>
          <p className="text-sm font-medium text-foreground/90">
            {t('home.recentTitle', { defaultValue: 'Continue a conversation' })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground/70">
            {t('home.recentDescription', { defaultValue: 'Jump back into your latest work.' })}
          </p>
        </div>
        <MessageSquare className="size-4 text-muted-foreground/60" />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className="group flex min-w-0 items-center justify-between rounded-xl border border-border/60 bg-background/45 px-3 py-3 text-left transition-colors hover:border-border hover:bg-muted/35"
            onClick={() => useUIStore.getState().navigateToSession(session.id)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground/85">{session.title}</span>
              <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/65">
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3" />
                  {new Date(session.updatedAt).toLocaleDateString()}
                </span>
                <span>{session.messageCount} messages</span>
              </span>
            </span>
            <ArrowUpRight className="ml-3 size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </section>
  )
}

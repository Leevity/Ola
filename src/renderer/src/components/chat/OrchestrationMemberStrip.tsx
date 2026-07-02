import { Bot, ScrollText } from 'lucide-react'
import type { OrchestrationMember } from '@renderer/lib/orchestration/types'
import { cn } from '@renderer/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'

function DotMatrix({ member }: { member: OrchestrationMember }): React.JSX.Element {
  const total = 24
  const progressFill = Math.round(total * Math.max(0, Math.min(1, member.progress)))
  const filled =
    member.status === 'completed'
      ? total
      : member.status === 'working'
        ? Math.max(8, Math.min(total - 2, progressFill || 16))
        : member.status === 'failed'
          ? Math.max(8, progressFill || 18)
          : Math.max(2, progressFill)

  return (
    <div
      className="grid gap-[2px]"
      style={{ gridTemplateColumns: 'repeat(12, 3px)' }}
      aria-hidden="true"
    >
      {Array.from({ length: total }).map((_, index) => {
        const isFilled = index < filled
        return (
          <span
            key={index}
            className={cn(
              'block size-[3px] rounded-[1px] transition-colors',
              !isFilled && 'bg-white/[0.08]',
              isFilled &&
                member.status === 'failed' &&
                'bg-destructive/80 shadow-[0_0_5px_rgba(248,113,113,0.35)]',
              isFilled &&
                member.status !== 'failed' &&
                'bg-[#8cff72] shadow-[0_0_5px_rgba(140,255,114,0.45)]'
            )}
          />
        )
      })}
    </div>
  )
}

function StatusDot({ status }: { status: OrchestrationMember['status'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'failed' && 'bg-destructive/80',
        status === 'working' && 'bg-[#8cff72] shadow-[0_0_6px_rgba(140,255,114,0.55)]',
        status === 'completed' && 'bg-white/38',
        status !== 'failed' && status !== 'working' && status !== 'completed' && 'bg-white/20'
      )}
    />
  )
}

function getMemberDescription(member: OrchestrationMember): string {
  return member.latestAction || member.summary || member.currentTaskLabel || 'Waiting to execute'
}

function getPromptText(member: OrchestrationMember): string {
  return member.prompt?.trim() || member.description?.trim() || ''
}

function MemberHoverContent({ member }: { member: OrchestrationMember }): React.JSX.Element {
  const promptText = getPromptText(member)

  return (
    <HoverCardContent
      side="top"
      align="start"
      className="w-[min(32rem,calc(100vw-3rem))] border-white/10 bg-[#141414]/98 p-0 text-white shadow-2xl backdrop-blur"
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 border-b border-white/10 pb-3">
          <div className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-[#1b1b1b] text-white/82">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white/88">{member.name}</div>
            <div className="mt-0.5 text-[11px] text-white/45">
              {member.agentName || member.role || 'subAgent'}
            </div>
          </div>
        </div>

        {promptText ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <ScrollText className="size-3" />
              <span>Prompt</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {promptText}
            </div>
          </section>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-2.5 py-2 text-[12px] text-white/45">
            No prompt available
          </div>
        )}
      </div>
    </HoverCardContent>
  )
}

export function OrchestrationMemberStrip({
  members,
  onOpenMember
}: {
  members: OrchestrationMember[]
  onOpenMember?: (member: OrchestrationMember) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {members.slice(0, 6).map((member, index) => {
        const card = (
          <button
            type="button"
            onClick={() => onOpenMember?.(member)}
            title={`${member.name} · ${getMemberDescription(member)}`}
            className={cn(
              'w-full rounded-[9px] bg-[#1f1f1f] px-3 py-2.5 text-left transition-colors',
              'hover:bg-[#242424] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/35',
              member.isSelected && 'ring-1 ring-emerald-400/25',
              member.status === 'failed' && 'bg-[#241919] hover:bg-[#2a1c1c]'
            )}
          >
            <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-x-3 gap-y-1">
              <div
                className={cn(
                  'row-span-2 flex size-7 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#141414] text-white/82',
                  member.status === 'working' && 'border-emerald-400/35 bg-emerald-400/10',
                  member.status === 'failed' &&
                    'border-destructive/35 bg-destructive/10 text-destructive'
                )}
              >
                <Bot className="size-4" />
              </div>

              <div className="min-w-0 self-center">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-white/82">
                    {member.name}
                  </span>
                  <StatusDot status={member.status} />
                </div>
              </div>

              <span className="self-center pl-3 text-[12px] font-semibold tabular-nums tracking-wide text-white/72">
                {String(index + 1).padStart(2, '0')}
              </span>

              <div className="min-w-0 self-end">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="-mt-1 h-4 w-3 shrink-0 rounded-bl-[5px] border-b border-l border-white/[0.14]" />
                  <p className="truncate text-[12px] leading-5 text-white/55">
                    {getMemberDescription(member)}
                  </p>
                </div>
              </div>

              <div className="self-end pb-1 pl-3">
                <DotMatrix member={member} />
              </div>
            </div>
          </button>
        )

        return member.prompt?.trim() || member.description?.trim() ? (
          <HoverCard key={member.id}>
            <HoverCardTrigger asChild>{card}</HoverCardTrigger>
            <MemberHoverContent member={member} />
          </HoverCard>
        ) : (
          <div key={member.id}>{card}</div>
        )
      })}
    </div>
  )
}

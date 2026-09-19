import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react'
import { useState } from 'react'
import type { OrchestrationRun } from '@renderer/lib/orchestration/types'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { OrchestrationMemberStrip } from './OrchestrationMemberStrip'

function getClusterTitle(run: OrchestrationRun): string {
  return run.kind === 'team' ? 'Agent Cluster' : 'Agent Execution'
}

function getTaskCountLabel(run: OrchestrationRun): string {
  if (run.kind === 'team') return `${run.members.length} parallel tasks`
  return `${run.members.length} tasks`
}

export function OrchestrationBlock({ run }: { run: OrchestrationRun }): React.JSX.Element {
  const openOrchestrationMember = useUIStore((s) => s.openOrchestrationMember)
  const openSubAgentExecutionDetail = useUIStore((s) => s.openSubAgentExecutionDetail)
  const [expanded, setExpanded] = useState(run.status !== 'completed')
  const statusLabel =
    run.status === 'running' ? 'Running' : run.status === 'failed' ? 'Needs attention' : 'Completed'

  return (
    <div
      className={cn(
        'my-3 overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#101010] p-3',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
        run.status === 'running' && 'border-emerald-400/15',
        run.status === 'failed' && 'border-destructive/25 bg-[#151010]'
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-0.5 text-left text-[12px] font-medium leading-none text-white/62"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <GitBranch className="size-3.5 shrink-0 text-white/45" />
        <span className="text-white/72">{getClusterTitle(run)}</span>
        <span className="text-white/25">|</span>
        <span className="min-w-0 flex-1 truncate">{getTaskCountLabel(run)}</span>
        <span className="text-[11px] text-white/42">{statusLabel}</span>
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-white/45" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-white/45" aria-hidden="true" />
        )}
      </button>

      {expanded ? (
        <div className="mt-2">
          <OrchestrationMemberStrip
            members={run.members}
            onOpenMember={(member) => {
              if (member.toolUseId) {
                openSubAgentExecutionDetail(
                  member.toolUseId,
                  member.report || member.summary || undefined,
                  member.name,
                  run.sessionId
                )
                return
              }
              openOrchestrationMember(run.id, member.id)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

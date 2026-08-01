import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { DRAW_PROMPT_PRESETS, type DrawPromptPreset } from './prompt-library'

export function PromptLibraryDialog({
  open,
  onOpenChange,
  onUsePrompt
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUsePrompt: (value: { title: string; prompt: string }) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(DRAW_PROMPT_PRESETS[0].id)
  const selected = DRAW_PROMPT_PRESETS.find((item) => item.id === selectedId)!
  const [draft, setDraft] = useState(selected.prompt)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized
      ? DRAW_PROMPT_PRESETS.filter((item) =>
          `${item.title} ${item.category} ${item.prompt}`.toLowerCase().includes(normalized)
        )
      : DRAW_PROMPT_PRESETS
  }, [query])

  useEffect(() => setDraft(selected.prompt), [selected])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('drawPage.graph.promptLibrary')}</DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('drawPage.graph.searchPrompts', { defaultValue: 'Search prompts' })}
        />
        <div className="grid min-h-80 grid-cols-[220px_1fr] gap-4">
          <div className="space-y-1 overflow-auto border-r pr-3">
            {filtered.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-xs hover:bg-muted',
                  selectedId === preset.id && 'bg-muted'
                )}
                onClick={() => setSelectedId(preset.id)}
              >
                <div className="font-medium">{preset.title}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{preset.category}</div>
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">{selected.title}</div>
            <Textarea
              className="min-h-64"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              {t('drawPage.graph.promptEditableHint', {
                defaultValue:
                  'Presets are editable starting points; your changes are used on the canvas.'
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!draft.trim()}
            onClick={() => {
              onUsePrompt({ title: selected.title, prompt: draft.trim() })
              onOpenChange(false)
            }}
          >
            {t('drawPage.graph.usePrompt', { defaultValue: 'Use prompt' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type { DrawPromptPreset }

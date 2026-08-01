import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'

const ANGLES = [
  { id: 'front', defaultLabel: 'Front view' },
  { id: 'three-quarter-left', defaultLabel: 'Three-quarter left' },
  { id: 'profile-right', defaultLabel: 'Right profile' },
  { id: 'rear', defaultLabel: 'Rear view' },
  { id: 'high-angle', defaultLabel: 'High angle' },
  { id: 'low-angle', defaultLabel: 'Low angle' }
] as const

export function AngleGenerationDialog({
  open,
  busy,
  onOpenChange,
  onGenerate
}: {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onGenerate: (angles: string[], instructions: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [selected, setSelected] = useState<string[]>([
    'front',
    'three-quarter-left',
    'profile-right'
  ])
  const [instructions, setInstructions] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('drawPage.graph.multiAngle', { defaultValue: 'Generate camera angles' })}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {ANGLES.map((angle) => (
            <label key={angle.id} className="flex items-center gap-2 rounded border p-2 text-xs">
              <Checkbox
                checked={selected.includes(angle.id)}
                onCheckedChange={(checked) =>
                  setSelected((items) =>
                    checked
                      ? items.includes(angle.id)
                        ? items
                        : [...items, angle.id]
                      : items.filter((item) => item !== angle.id)
                  )
                }
              />
              {t(`drawPage.graph.angle.${angle.id}`, { defaultValue: angle.defaultLabel })}
            </label>
          ))}
        </div>
        <Textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('drawPage.graph.angleInstructions', {
            defaultValue: 'Optional continuity or background instructions'
          })}
        />
        <div className="text-xs text-muted-foreground">
          {t('drawPage.graph.angleCostHint', {
            defaultValue: 'Each selected angle creates a separate provider request.'
          })}
        </div>
        <DialogFooter>
          <Button
            disabled={busy || selected.length === 0}
            onClick={() => onGenerate(selected, instructions.trim())}
          >
            {t('drawPage.graph.generateCount', {
              count: selected.length,
              defaultValue: `Generate ${selected.length}`
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

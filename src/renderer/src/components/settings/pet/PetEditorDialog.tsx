import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { CapybaraSprite } from '@renderer/components/pet/CapybaraSprite'
import { getCombinedGrowth, getPetLevel, usePetsStore, type Pet } from '@renderer/stores/pets-store'
import { isDefaultPet, renameDefaultPet } from '@renderer/lib/pet/default-pet-sync'
import { OverviewSection } from './pet-editor/OverviewSection'
import { SkinSection } from './pet-editor/SkinSection'
import { AgentSection } from './pet-editor/AgentSection'
import { ExpSection } from './pet-editor/ExpSection'

const EDITOR_TABS = ['overview', 'skin', 'agent', 'exp'] as const
type EditorTab = (typeof EDITOR_TABS)[number]

interface PetEditorDialogProps {
  petId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PetEditorDialog({
  petId,
  open,
  onOpenChange
}: PetEditorDialogProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  // Subscribe to a single, flat projection of the pet so unrelated pets'
  // tick updates don't re-render the dialog body. The dialog stays cheap
  // when 5+ pets are alive at once.
  const pet = usePetsStore((s) => (petId ? (s.pets.find((p) => p.id === petId) ?? null) : null))
  const renamePet = usePetsStore((s) => s.renamePet)
  const [tab, setTab] = useState<EditorTab>('overview')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  const headerStats = useMemo(() => {
    if (!pet) return null
    return {
      level: getPetLevel(getCombinedGrowth(pet)),
      hunger: pet.hunger,
      cleanliness: pet.cleanliness,
      mood: pet.mood
    }
  }, [pet])

  if (!pet) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>{t('editor.notFound')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t('editor.notFoundDesc')}</p>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close', { defaultValue: 'Close' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden p-0">
        <Header
          pet={pet}
          headerStats={headerStats}
          editingName={editingName}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          startEditName={() => {
            setNameDraft(pet.name)
            setEditingName(true)
          }}
          cancelEditName={() => setEditingName(false)}
          commitEditName={() => {
            const next = nameDraft.trim()
            if (!next || next === pet.name) {
              setEditingName(false)
              return
            }
            if (isDefaultPet(pet.id)) {
              renameDefaultPet(next)
            } else {
              renamePet(pet.id, next)
            }
            toast.success(t('basic.saved'))
            setEditingName(false)
          }}
        />
        <Tabs tab={tab} setTab={setTab} />
        <div className="max-h-[55vh] overflow-y-auto px-5 pb-5">
          {tab === 'overview' ? <OverviewSection pet={pet} /> : null}
          {tab === 'skin' ? <SkinSection pet={pet} /> : null}
          {tab === 'agent' ? <AgentSection pet={pet} /> : null}
          {tab === 'exp' ? <ExpSection pet={pet} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Header({
  pet,
  headerStats,
  editingName,
  nameDraft,
  setNameDraft,
  startEditName,
  cancelEditName,
  commitEditName
}: {
  pet: Pet
  headerStats: { level: number; hunger: number; cleanliness: number; mood: number } | null
  editingName: boolean
  nameDraft: string
  setNameDraft: (v: string) => void
  startEditName: () => void
  cancelEditName: () => void
  commitEditName: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pet')
  const adoptedDate = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(pet.adoptedAt))
  return (
    <div className="flex items-start gap-4 border-b border-border/60 bg-muted/30 p-5">
      <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-background">
        <CapybaraSprite
          activity="idle"
          facing="right"
          mood={headerStats?.mood ?? 80}
          cleanliness={headerStats?.cleanliness ?? 80}
          width={88}
          skinId={pet.skinId}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {editingName ? (
            <>
              <Input
                autoFocus
                value={nameDraft}
                maxLength={20}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEditName()
                  if (e.key === 'Escape') cancelEditName()
                }}
                className="h-7 max-w-44 text-sm"
              />
              <Button size="icon" variant="ghost" className="size-7" onClick={commitEditName}>
                <Check className="size-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={cancelEditName}>
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              <DialogTitle className="truncate text-lg">{pet.name}</DialogTitle>
              <Button size="icon" variant="ghost" className="size-7" onClick={startEditName}>
                <Pencil className="size-3.5" />
              </Button>
            </>
          )}
        </div>
        {headerStats ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('editor.headerLine', {
              level: headerStats.level,
              hunger: Math.round(headerStats.hunger),
              clean: Math.round(headerStats.cleanliness),
              mood: Math.round(headerStats.mood)
            })}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {t('editor.adoptedAt', { date: adoptedDate })}
        </p>
      </div>
    </div>
  )
}

function Tabs({
  tab,
  setTab
}: {
  tab: EditorTab
  setTab: (t: EditorTab) => void
}): React.JSX.Element {
  const { t } = useTranslation('pet')
  return (
    <div className="flex flex-wrap gap-1 border-b border-border/60 bg-muted/10 px-5 py-2">
      {EDITOR_TABS.map((id) => (
        <Button
          key={id}
          size="sm"
          variant={tab === id ? 'default' : 'ghost'}
          className="h-7 text-xs"
          onClick={() => setTab(id)}
        >
          {t(`editor.tabs.${id}`)}
        </Button>
      ))}
    </div>
  )
}

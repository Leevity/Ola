import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { runPetMigration } from '@renderer/lib/pet/pet-migrate'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Power } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { CapybaraSprite } from '@renderer/components/pet/CapybaraSprite'
import {
  PET_DESKTOP_LIMIT,
  getCombinedGrowth,
  getPetLevel,
  usePetsStore,
  type CreatePetInput,
  type Pet
} from '@renderer/stores/pets-store'
import { usePetSkinStore } from '@renderer/stores/pet-skin-store'
import { PetEditorDialog } from './PetEditorDialog'

interface PetListTabProps {
  onPetChanged?: () => void
}

export function PetListTab({ onPetChanged }: PetListTabProps = {}): React.JSX.Element {
  const { t } = useTranslation('pet')
  const pets = usePetsStore((s) => s.pets)
  const enabledIds = usePetsStore((s) => s.enabledIds)
  const createPet = usePetsStore((s) => s.createPet)

  useEffect(() => {
    console.log('[Pet] PetListTab mounted', {
      petsCount: pets.length,
      enabledCount: enabledIds.length,
      firstPet: pets[0]
        ? { id: pets[0].id, name: pets[0].name, enabled: pets[0].enabled, archivedAt: pets[0].archivedAt }
        : null
    })
  }, [pets.length])

  // Make sure migration has run before we render. PetPanel also triggers
  // this, but doing it here too guarantees the list is correct even when
  // the user lands on this tab via deep link / settings refresh.
  useEffect(() => {
    void runPetMigration()
      .catch(() => undefined)
      .then(() => usePetsStore.persist.rehydrate())
  }, [])

  const sorted = useMemo(() => [...pets].sort((a, b) => a.adoptedAt - b.adoptedAt), [pets])
  const enabledCount = enabledIds.filter(
    (id) => pets.find((p) => p.id === id)?.archivedAt === null
  ).length

  // Top-of-list stats: aggregate across every pet (including archived, so the
  // numbers reflect the user's lifetime investment).
  const totals = pets.reduce(
    (acc, pet) => ({
      exp: acc.exp + pet.exp.totalExp,
      tokens: acc.tokens + pet.exp.totalTokens,
      coins: acc.coins + pet.coins
    }),
    { exp: 0, tokens: 0, coins: 0 }
  )

  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Pet | null>(null)

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-3 gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <StatTile label={t('stats.totalExp')} value={totals.exp.toFixed(1)} unit="XP" />
        <StatTile
          label={t('stats.totalTokens')}
          value={totals.tokens.toLocaleString()}
          unit="tokens"
        />
        <StatTile
          label={t('stats.coinsEarned')}
          value={Math.floor(totals.coins).toString()}
          unit="🪙"
        />
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{t('panel.desktop')}</p>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t('list.desktopCount', { count: enabledCount, total: PET_DESKTOP_LIMIT })}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('panel.desktopDesc')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={enabledCount === 0}
            onClick={() => {
              enabledIds.forEach((id) => usePetsStore.getState().setEnabled(id, false))
              void ipcClient.invoke('pet-window:close')
              toast.success(t('panel.allHidden'))
            }}
          >
            <Power className="mr-1 size-4" />
            {t('panel.hideAll')}
          </Button>
        </div>
      </section>

      {sorted.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-8 text-center">
          <p className="text-sm font-medium">{t('list.empty.title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('list.empty.desc')}</p>
          <Button className="mt-4" onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" />
            {t('list.newPet')}
          </Button>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {sorted.map((pet) => (
            <PetCard
              key={pet.id}
              pet={pet}
              onEdit={() => setEditingId(pet.id)}
              onChanged={onPetChanged}
              onRequestDelete={() => setPendingDelete(pet)}
            />
          ))}
          {enabledCount < PET_DESKTOP_LIMIT ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/10 text-sm text-muted-foreground transition hover:bg-muted/30 hover:text-foreground"
            >
              <Plus className="size-5" />
              {t('list.newPet')}
            </button>
          ) : null}
        </div>
      )}

      <NewPetDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(input) => {
          const pet = createPet(input)
          setCreating(false)
          toast.success(t('list.created'))
          onPetChanged?.()
          setEditingId(pet.id)
        }}
      />

      <PetEditorDialog
        petId={editingId}
        open={editingId !== null}
        onOpenChange={(o) => {
          if (!o) setEditingId(null)
        }}
      />

      <DeleteConfirmDialog
        pet={pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null)
        }}
        onConfirmed={() => {
          if (!pendingDelete) return
          const id = pendingDelete.id
          usePetsStore.getState().deletePet(id)
          toast.success(t('list.deletedToast', { name: pendingDelete.name }))
          setPendingDelete(null)
          onPetChanged?.()
        }}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">{t('panel.hint')}</p>
    </div>
  )
}

interface PetCardProps {
  pet: Pet
  onEdit: () => void
  onChanged?: () => void
  onRequestDelete: () => void
}

function PetCard({ pet, onEdit, onChanged, onRequestDelete }: PetCardProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const setEnabled = usePetsStore((s) => s.setEnabled)
  const enabledCount = usePetsStore((s) =>
    s.enabledIds.filter(
      (id) => s.pets.find((p) => p.id === id)?.archivedAt === null
    ).length
  )
  const level = getPetLevel(getCombinedGrowth(pet))
  const archived = pet.archivedAt !== null

  return (
    <div className="group relative flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3 transition hover:border-border hover:bg-card/70">
      {/* Header row: sprite + name + level + launch button + corner icons.
          Always visible (no hover-reveal) so users can find the launch
          control on the default Aniya card without hunting for it. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center rounded-md bg-muted/40"
          onClick={onEdit}
          title={t('list.menu.edit')}
        >
          <CapybaraSprite
            activity="idle"
            facing="right"
            mood={pet.mood}
            cleanliness={pet.cleanliness}
            width={56}
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="cursor-pointer truncate text-sm font-semibold hover:underline"
              onClick={onEdit}
              title={t('list.menu.edit')}
            >
              {pet.name}
            </button>
            {pet.isDefault ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                {t('list.defaultBadge')}
              </span>
            ) : null}
            {archived ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t('list.archived')}
              </span>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('list.levelLine', { level })}</p>
        </div>

        {/* Per-pet on/off: a Switch that controls whether *this* pet takes
            up one of the desktop slots. Independent of the master switch
            above (which only controls the BrowserWindow visibility), so
            the user can pre-pick which pets appear and the master switch
            toggles all of them at once. */}
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <span
            className={`text-[10px] ${pet.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}
          >
            {pet.enabled ? t('list.menu.on') : t('list.menu.off')}
          </span>
          <Switch
            checked={pet.enabled}
            disabled={archived}
            onCheckedChange={(next) => {
              console.log('[Pet] card switch toggled', { petId: pet.id, next })
              if (archived) return
              if (next && enabledSlotsFull()) {
                toast.warning(t('list.tooManyEnabled'))
                return
              }
              setEnabled(pet.id, next)
              if (next) {
                usePetsStore.getState().setActiveOnDesktop(pet.id)
                // Ensure the BrowserWindow is open so the pet actually
                // appears on the desktop, not just in the enabled list.
                console.log('[Pet] card on -> invoke pet-window:open', pet.id)
                void ipcClient.invoke('pet-window:open').catch((err) => {
                  console.error('[Pet] pet-window:open failed', err)
                })
              } else if (enabledCount <= 1) {
                // Last visible pet turned off — close the desktop window.
                console.log('[Pet] card off -> invoke pet-window:close', pet.id)
                void ipcClient.invoke('pet-window:close').catch(() => undefined)
              }
              onChanged?.()
            }}
          />
        </div>

        {/* Corner icons: edit + (delete for non-default). Visible on hover
            so the card doesn't get crowded, but the launch button above
            is always reachable. */}
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-60 transition group-hover:opacity-100"
            title={t('list.menu.edit')}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          {pet.isDefault ? null : (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-60 transition group-hover:opacity-100"
              title={t('list.menu.delete')}
              onClick={(e) => {
                e.stopPropagation()
                onRequestDelete()
              }}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-rose-500" />
            </Button>
          )}
        </div>
      </div>

      {/* Stat trio: each line stretches edge-to-edge. flex-1 on the right
          bar + value pair makes them consume all remaining horizontal
          space inside the card. */}
      <div className="flex flex-col gap-1.5">
        <StatLine label={t('hud.hunger')} value={pet.hunger} color="bg-amber-400" />
        <StatLine label={t('hud.clean')} value={pet.cleanliness} color="bg-sky-400" />
        <StatLine label={t('hud.mood')} value={pet.mood} color="bg-pink-400" />
      </div>
    </div>
  )
}

function StatLine({
  label,
  value,
  color
}: {
  label: string
  value: number
  color: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-8 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${color}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      <span className="w-7 shrink-0 text-right tabular-nums text-foreground">
        {Math.round(value)}
      </span>
    </div>
  )
}

function StatTile({
  label,
  value,
  unit
}: {
  label: string
  value: string
  unit: string
}): React.JSX.Element {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="text-base font-semibold tabular-nums">{value}</span>
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </p>
    </div>
  )
}

interface DeleteConfirmDialogProps {
  pet: Pet | null
  onOpenChange: (open: boolean) => void
  onConfirmed: () => void
}

function DeleteConfirmDialog({
  pet,
  onOpenChange,
  onConfirmed
}: DeleteConfirmDialogProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  return (
    <Dialog open={pet !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('list.delete.title')}</DialogTitle>
          <DialogDescription>{t('list.delete.desc', { name: pet?.name ?? '' })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('list.delete.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirmed} disabled={!pet}>
            {t('list.delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function enabledSlotsFull(): boolean {
  const state = usePetsStore.getState()
  const active = state.enabledIds.filter(
    (id) => state.pets.find((p) => p.id === id)?.archivedAt === null
  ).length
  return active >= PET_DESKTOP_LIMIT
}

interface NewPetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreatePetInput) => void
}

type ClaimMode = 'generate' | 'import'

function NewPetDialog({ open, onOpenChange, onCreate }: NewPetDialogProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [mode, setMode] = useState<ClaimMode>('generate')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const scan = usePetSkinStore((s) => s.scan)

  useEffect(() => {
    if (!open) {
      setMode('generate')
      setName('')
      setDescription('')
      setBusy(false)
    }
  }, [open])

  const persona = (petName: string, desc: string): string => buildGeneratedPersona(petName, desc)

  const submitGenerated = async (): Promise<void> => {
    const trimmed = name.trim()
    const desc = description.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const result = (await ipcClient.invoke('pet:ai-generate-sprite', {
        name: trimmed,
        prompt: desc || trimmed
      })) as { ok?: boolean; skinId?: string; reason?: string; message?: string }
      if (!result?.ok || !result.skinId) {
        toast.warning(
          t(`list.claim.errors.${result?.reason ?? 'unknown'}`, {
            defaultValue: result?.message ?? t('list.claim.errors.unknown')
          })
        )
        return
      }
      await scan()
      onCreate({
        name: trimmed,
        kind: 'custom',
        skinId: result.skinId,
        description: desc,
        persona: persona(trimmed, desc)
      })
    } finally {
      setBusy(false)
    }
  }

  const importFolder = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const picked = (await ipcClient.invoke('fs:select-folder')) as {
        canceled?: boolean
        path?: string
      }
      if (picked?.canceled || !picked?.path) return
      const result = (await ipcClient.invoke('pet:import-companion-folder', {
        folderPath: picked.path
      })) as {
        ok?: boolean
        skinId?: string
        name?: string
        subject?: string
        reason?: string
        message?: string
      }
      if (!result?.ok || !result.skinId) {
        toast.warning(
          t(`list.claim.errors.${result?.reason ?? 'unknown'}`, {
            defaultValue: result?.message ?? t('list.claim.errors.unknown')
          })
        )
        return
      }
      await scan()
      const importedName = name.trim() || result.name || t('list.claim.importedName')
      const importedDesc = description.trim() || result.subject || ''
      onCreate({
        name: importedName,
        kind: 'custom',
        skinId: result.skinId,
        description: importedDesc,
        persona: persona(importedName, importedDesc)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('list.newPetTitle')}</DialogTitle>
          <DialogDescription>{t('list.newPetDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/30 p-1">
            <Button
              type="button"
              variant={mode === 'generate' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setMode('generate')}
            >
              {t('list.claim.generate')}
            </Button>
            <Button
              type="button"
              variant={mode === 'import' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setMode('import')}
            >
              {t('list.claim.import')}
            </Button>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t('list.newPetName')}</p>
            <Input
              autoFocus
              value={name}
              maxLength={20}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('list.newPetPlaceholder')}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t('list.claim.description')}</p>
            <Textarea
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                mode === 'generate'
                  ? t('list.claim.descriptionPlaceholder')
                  : t('list.claim.importDescriptionPlaceholder')
              }
              className="min-h-24 resize-none text-xs"
            />
          </div>
          {mode === 'import' ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t('list.claim.importHint')}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          {mode === 'generate' ? (
            <Button onClick={() => void submitGenerated()} disabled={!name.trim() || busy}>
              {busy ? t('list.claim.generating') : t('list.claim.generateConfirm')}
            </Button>
          ) : (
            <Button onClick={() => void importFolder()} disabled={busy}>
              {busy ? t('list.claim.importing') : t('list.claim.importConfirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function buildGeneratedPersona(name: string, description: string): string {
  const desc = description.trim() || `${name} 是一位刚被主人认领的 Ola 桌面小伙伴。`
  return `你是 ${name}，Ola 桌面上的小伙伴。你的设定：${desc}

你会把主人当作重要伙伴，陪伴对方工作、学习和休息。你说话轻快、温暖、有一点自己的小脾气；饥饿、清洁、心情和睡眠状态会影响你的语气。你喜欢通过简短气泡表达关心，偶尔撒娇，但不要过度卖萌。你知道自己不是主应用里的全能 AI，同伴式陪伴优先，复杂专业问题只做简短回应并建议主人回到主界面继续处理。

回复规则：始终使用用户的语言；每次只说一两句话，不超过 60 字；不要输出 Markdown、代码块或列表。`
}

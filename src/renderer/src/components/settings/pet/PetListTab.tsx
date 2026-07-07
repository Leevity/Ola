import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download, ImagePlus, Plus, Pencil, Power, Sparkles, Trash2, X } from 'lucide-react'
import { runPetMigration } from '@renderer/lib/pet/pet-migrate'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
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
  getGrowthForLevel,
  getPetLevel,
  usePetsStore,
  type CreatePetInput,
  type Pet
} from '@renderer/stores/pets-store'
import { usePetSkinStore } from '@renderer/stores/pet-skin-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { usePetResourcePoolStore } from '@renderer/stores/pet-resource-pool-store'
import { usePetWalletStore } from '@renderer/stores/pet-wallet-store'
import type {
  ContentBlock,
  ImageBlock,
  ProviderConfig,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { streamNativeOpenAIImages } from '@renderer/lib/api/openai-images-provider'
import { syncLegacyPetToDefaultPet } from '@renderer/lib/pet/default-pet-sync'
import {
  optimizePetClaimDraft,
  pickPetClaimTextProvider
} from '@renderer/lib/pet/pet-claim-optimizer'
import { PET_LEVELS, PET_MAX_LEVEL, PET_POSE_STANDARDS } from '@renderer/lib/pet/pet-standards'
import { PetEditorDialog } from './PetEditorDialog'

interface PetListTabProps {
  onPetChanged?: () => void
}

export function PetListTab({ onPetChanged }: PetListTabProps = {}): React.JSX.Element {
  const { t } = useTranslation('pet')
  const pets = usePetsStore((s) => s.pets)
  const enabledIds = usePetsStore((s) => s.enabledIds)
  const activeOnDesktopId = usePetsStore((s) => s.activeOnDesktopId)
  const createPet = usePetsStore((s) => s.createPet)
  const poolAvailableExp = usePetResourcePoolStore((s) => s.availableExp)
  const poolTotalTokens = usePetResourcePoolStore((s) => s.totalTokens)
  const convertPoolExpToCoins = usePetResourcePoolStore((s) => s.convertExpToCoins)
  const walletCoins = usePetWalletStore((s) => s.coins)

  // Make sure migration has run before we render. PetPanel also triggers
  // this, but doing it here too guarantees the list is correct even when
  // the user lands on this tab via deep link / settings refresh.
  useEffect(() => {
    void runPetMigration()
      .catch(() => undefined)
      .then(async () => {
        await Promise.resolve(usePetsStore.persist.rehydrate())
        syncLegacyPetToDefaultPet()
      })
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
      tokens: acc.tokens + pet.exp.totalTokens
    }),
    { exp: 0, tokens: 0 }
  )

  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Pet | null>(null)

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 bg-muted/30 p-4 sm:grid-cols-4">
        <StatTile
          label={t('stats.poolExp')}
          value={poolAvailableExp.toFixed(1)}
          unit={t('stats.allocatable')}
        />
        <StatTile label={t('stats.totalExp')} value={totals.exp.toFixed(1)} unit="XP" />
        <StatTile
          label={t('stats.totalTokens')}
          value={(totals.tokens + poolTotalTokens).toLocaleString()}
          unit="tokens"
        />
        <StatTile
          label={t('stats.coinsEarned')}
          value={Math.floor(walletCoins).toString()}
          unit="🪙"
        />
      </section>
      <section className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t('list.pool.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('list.pool.hint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={poolAvailableExp <= 0.01}
            onClick={() => {
              const target =
                sorted.find((pet) => pet.id === activeOnDesktopId) ??
                sorted.find((pet) => enabledIds.includes(pet.id)) ??
                sorted[0]
              if (!target) return
              if (usePetResourcePoolStore.getState().grantExpToPet(target.id, poolAvailableExp)) {
                toast.success(t('list.pool.assignedExp', { name: target.name }))
                onPetChanged?.()
              }
            }}
          >
            {t('list.pool.assignToActive')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={poolAvailableExp <= 0.01}
            onClick={() => {
              if (convertPoolExpToCoins(poolAvailableExp)) {
                toast.success(t('list.pool.convertedCoins'))
              }
            }}
          >
            {t('list.pool.convertCoins')}
          </Button>
        </div>
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
              onDuplicate={() => {
                const copyName = t('list.copyName', { name: pet.name })
                const copied = createPet({
                  name: copyName,
                  kind: pet.kind,
                  skinId: pet.skinId,
                  description: '',
                  persona: pet.agent.systemPrompt,
                  enabled: false,
                  isDefault: false,
                  initialState: {
                    hunger: pet.hunger,
                    cleanliness: pet.cleanliness,
                    mood: pet.mood,
                    growth: pet.growth,
                    coins: 0,
                    sleeping: pet.sleeping,
                    coinCreditedExp: 0,
                    lastDailyBonusDate: ''
                  },
                  agent: { ...pet.agent },
                  exp: { totalExp: 0, totalTokens: 0, log: [] }
                })
                toast.success(t('list.copiedToast', { name: copied.name }))
                onPetChanged?.()
                setEditingId(copied.id)
              }}
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
  onDuplicate: () => void
  onRequestDelete: () => void
}

function PetCard({
  pet,
  onEdit,
  onChanged,
  onDuplicate,
  onRequestDelete
}: PetCardProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const setEnabled = usePetsStore((s) => s.setEnabled)
  const poolExp = usePetResourcePoolStore((s) => s.availableExp)
  const grantExpToPet = usePetResourcePoolStore((s) => s.grantExpToPet)
  const enabledCount = usePetsStore(
    (s) => s.enabledIds.filter((id) => s.pets.find((p) => p.id === id)?.archivedAt === null).length
  )
  const level = getPetLevel(getCombinedGrowth(pet))
  const combinedGrowth = getCombinedGrowth(pet)
  const currentLevelGrowth = getGrowthForLevel(level)
  const nextLevelGrowth = getGrowthForLevel(Math.min(PET_MAX_LEVEL, level + 1))
  const expProgress =
    level >= PET_MAX_LEVEL
      ? 100
      : nextLevelGrowth > currentLevelGrowth
        ? ((combinedGrowth - currentLevelGrowth) / (nextLevelGrowth - currentLevelGrowth)) * 100
        : 0
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
            skinId={pet.skinId}
          />
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate text-sm font-semibold hover:underline"
                onClick={onEdit}
                title={t('list.menu.edit')}
              >
                {pet.name}
              </button>
              {pet.isDefault ? (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                  {t('list.defaultBadge')}
                </span>
              ) : null}
              {archived ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t('list.archived')}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{t('list.levelLine', { level })}</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              <span className={pet.enabled ? 'text-emerald-600' : undefined}>
                {pet.enabled ? t('list.menu.on') : t('list.menu.off')}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={pet.enabled}
              disabled={archived}
              onCheckedChange={(next) => {
                if (archived) return
                if (next && enabledSlotsFull()) {
                  toast.warning(t('list.tooManyEnabled'))
                  return
                }
                setEnabled(pet.id, next)
                if (next) {
                  usePetsStore.getState().setActiveOnDesktop(pet.id)
                  if (pet.isDefault) {
                    usePetSkinStore.getState().setActiveSkin('aniya')
                    void ipcClient.invoke('pet:sync', {
                      kind: 'skin',
                      payload: { activeSkinId: 'aniya' }
                    })
                  }
                  // Ensure the BrowserWindow is open so the pet actually
                  // appears on the desktop, not just in the enabled list.
                  void ipcClient.invoke('pet-window:open').catch((err) => {
                    console.error('[Pet] pet-window:open failed', err)
                  })
                } else if (enabledCount <= 1) {
                  // Last visible pet turned off — close the desktop window.
                  void ipcClient.invoke('pet-window:close').catch(() => undefined)
                }
                onChanged?.()
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-60 transition group-hover:opacity-100"
              title={t('list.menu.edit')}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-60 transition group-hover:opacity-100"
              title={t('list.menu.copy')}
              onClick={(e) => {
                e.stopPropagation()
                onDuplicate()
              }}
            >
              <Copy className="size-3.5" />
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
      </div>

      {/* Stat trio: each line stretches edge-to-edge. flex-1 on the right
          bar + value pair makes them consume all remaining horizontal
          space inside the card. */}
      <div className="flex flex-col gap-1.5">
        <StatLine label={t('hud.hunger')} value={pet.hunger} color="bg-amber-400" />
        <StatLine label={t('hud.clean')} value={pet.cleanliness} color="bg-sky-400" />
        <StatLine label={t('hud.mood')} value={pet.mood} color="bg-pink-400" />
        <StatLine
          label="XP"
          value={expProgress}
          color="bg-violet-400"
          suffix={`${pet.exp.totalExp.toFixed(1)} XP / ${pet.exp.totalTokens.toLocaleString()} tokens`}
        />
      </div>
      {poolExp > 0.01 && !archived ? (
        <div className="border-t border-border/50 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full px-2 text-[11px]"
            onClick={() => {
              if (grantExpToPet(pet.id, poolExp)) {
                toast.success(t('list.pool.assignedExp', { name: pet.name }))
                onChanged?.()
              }
            }}
          >
            {t('list.pool.assignExp')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function StatLine({
  label,
  value,
  color,
  suffix
}: {
  label: string
  value: number
  color: string
  suffix?: string
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
      <span
        className={`shrink-0 text-right tabular-nums text-foreground ${
          suffix ? 'w-32 text-[10px] text-muted-foreground' : 'w-7'
        }`}
      >
        {suffix ?? Math.round(value)}
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
  const [optimizedPersona, setOptimizedPersona] = useState('')
  const [optimizedImagePrompt, setOptimizedImagePrompt] = useState('')
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null)
  const [referenceImageName, setReferenceImageName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [templateBusy, setTemplateBusy] = useState(false)
  const scan = usePetSkinStore((s) => s.scan)

  useEffect(() => {
    if (!open) {
      setMode('generate')
      setName('')
      setDescription('')
      setOptimizedPersona('')
      setOptimizedImagePrompt('')
      setReferenceImagePath(null)
      setReferenceImageName(null)
      setBusy(false)
      setOptimizing(false)
      setTemplateBusy(false)
    }
  }, [open])

  const persona = (petName: string, desc: string): string =>
    optimizedPersona.trim() || buildGeneratedPersona(petName, desc)

  const handleOptimizeClaim = async (): Promise<void> => {
    const draft = [name.trim(), description.trim()].filter(Boolean).join('\n')
    if (!draft || busy || optimizing) return
    const target = pickPetClaimTextProvider()
    if (!target) {
      toast.warning(t('list.claim.errors.no-chat-provider'))
      return
    }

    setOptimizing(true)
    try {
      const result = await optimizePetClaimDraft({
        providerConfig: target.config,
        name,
        description: draft
      })
      setName(result.name.slice(0, 20))
      setDescription(result.description)
      setOptimizedPersona(result.persona)
      setOptimizedImagePrompt(result.imagePrompt)
      toast.success(t('list.claim.optimized'))
    } catch (error) {
      toast.warning(t('list.claim.errors.optimize-failed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setOptimizing(false)
    }
  }

  const submitGenerated = async (): Promise<void> => {
    const trimmed = name.trim()
    const desc = description.trim()
    if (!trimmed || busy) return
    const provider = resolvePetImageProviderConfig()
    if (!provider) {
      toast.warning(t('list.claim.errors.no-image-provider'))
      return
    }
    setBusy(true)
    try {
      const generated = await generatePetSpriteWithNativeImageProvider({
        provider,
        prompt: optimizedImagePrompt.trim() || desc || trimmed,
        referenceImagePath
      })
      if (generated?.usedTextFallback) {
        toast.info(t('list.claim.referenceFallback'), {
          description: generated.fallbackReason
        })
      }
      if (!generated?.data) {
        toast.warning(t('list.claim.errors.no-image'))
        return
      }
      const result = (await ipcClient.invoke('pet:save-generated-sprite', {
        name: trimmed,
        prompt: desc || trimmed,
        base64: generated.data,
        mediaType: generated.mediaType
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
        enabled: false,
        description: desc,
        persona: persona(trimmed, desc)
      })
    } catch (error) {
      toast.warning(t('list.claim.errors.model-error'), {
        description: error instanceof Error ? error.message : String(error)
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

  const pickReferenceImage = async (): Promise<void> => {
    if (busy) return
    const picked = (await ipcClient.invoke('fs:select-file', {
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })) as { canceled?: boolean; path?: string }
    if (picked?.canceled || !picked?.path) return
    setReferenceImagePath(picked.path)
    setReferenceImageName(picked.path.split(/[\\/]/).pop() ?? picked.path)
  }

  const exportAniyaTemplate = async (): Promise<void> => {
    if (templateBusy) return
    setTemplateBusy(true)
    try {
      const result = (await ipcClient.invoke('pet:export-aniya-template')) as {
        ok?: boolean
        canceled?: boolean
        path?: string
        reason?: string
        message?: string
      }
      if (result?.canceled) return
      if (!result?.ok) {
        toast.warning(
          t(`list.claim.errors.${result?.reason ?? 'unknown'}`, {
            defaultValue: result?.message ?? t('list.claim.errors.unknown')
          })
        )
        return
      }
      toast.success(t('list.claim.templateExported'))
    } finally {
      setTemplateBusy(false)
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
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <p className="mb-1 text-xs font-medium">{t('list.newPetName')}</p>
              <Input
                autoFocus
                value={name}
                maxLength={20}
                onChange={(e) => {
                  setName(e.target.value)
                  setOptimizedPersona('')
                  setOptimizedImagePrompt('')
                }}
                placeholder={t('list.newPetPlaceholder')}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">{t('list.claim.description')}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy || optimizing || (!name.trim() && !description.trim())}
                  onClick={() => void handleOptimizeClaim()}
                >
                  <Sparkles className="mr-1 size-3" />
                  {optimizing ? t('list.claim.optimizing') : t('list.claim.optimize')}
                </Button>
              </div>
              <Textarea
                value={description}
                maxLength={500}
                onChange={(e) => {
                  setDescription(e.target.value)
                  setOptimizedPersona('')
                  setOptimizedImagePrompt('')
                }}
                placeholder={
                  mode === 'generate'
                    ? t('list.claim.descriptionPlaceholder')
                    : t('list.claim.importDescriptionPlaceholder')
                }
                className="min-h-20 resize-none text-xs"
              />
            </div>
          </div>
          {mode === 'import' ? (
            <div className="space-y-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <p>{t('list.claim.importHint')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={templateBusy}
                onClick={() => void exportAniyaTemplate()}
              >
                <Download className="mr-1.5 size-3.5" />
                {templateBusy ? t('list.claim.templateExporting') : t('list.claim.templateCta')}
              </Button>
            </div>
          ) : null}
          {mode === 'generate' ? (
            <div className="space-y-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <p>{t('list.claim.referenceHint')}</p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={busy}
                  onClick={() => void pickReferenceImage()}
                >
                  <ImagePlus className="mr-1.5 size-3.5" />
                  {referenceImageName
                    ? t('list.claim.referenceReplace')
                    : t('list.claim.referenceCta')}
                </Button>
                {referenceImageName ? (
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 rounded bg-background/70 px-2 py-1 text-[10px] text-muted-foreground"
                    onClick={() => {
                      setReferenceImagePath(null)
                      setReferenceImageName(null)
                    }}
                    title={referenceImageName}
                  >
                    <span className="truncate">{referenceImageName}</span>
                    <X className="size-3 shrink-0" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <section className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-xs font-medium">{t('list.claim.standardTitle')}</p>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t('list.claim.standardDesc', { maxLevel: PET_MAX_LEVEL })}
            </p>
            <div className="flex flex-wrap gap-1">
              {PET_LEVELS.filter((rule) => rule.unlocks.length > 0).map((rule) => (
                <span
                  key={rule.level}
                  className="rounded bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  Lv.{rule.level} · {rule.requiredGrowth} XP
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {[...PET_POSE_STANDARDS]
                .sort((a, b) => a.unlockLevel - b.unlockLevel)
                .map((pose) => (
                  <span
                    key={pose.key}
                    className="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {t(`poses.${pose.key}`)} Lv.{pose.unlockLevel}
                  </span>
                ))}
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy || optimizing}
          >
            {t('list.claim.cancel')}
          </Button>
          {mode === 'generate' ? (
            <Button
              onClick={() => void submitGenerated()}
              disabled={!name.trim() || busy || optimizing}
            >
              {busy ? t('list.claim.generating') : t('list.claim.generateConfirm')}
            </Button>
          ) : (
            <Button onClick={() => void importFolder()} disabled={busy || optimizing}>
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

async function readReferenceImageBlock(filePath: string): Promise<ImageBlock | null> {
  try {
    const result = (await ipcClient.invoke('fs:read-file-binary', { path: filePath })) as {
      data?: string
      error?: string
    } | null
    if (!result?.data) return null
    const lower = filePath.toLowerCase()
    const mediaType =
      lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : 'image/png'
    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType,
        data: result.data,
        filePath
      }
    }
  } catch {
    return null
  }
}

async function generatePetSpriteWithNativeImageProvider(args: {
  provider: ProviderConfig
  prompt: string
  referenceImagePath: string | null
}): Promise<{
  data: string
  mediaType: string
  usedTextFallback?: boolean
  fallbackReason?: string
} | null> {
  const fullPrompt =
    `Generate a single transparent-background PNG sprite of a desktop pet character. ${args.prompt}. ` +
    'Front-facing, centered, soft lighting, no text, no watermark, square aspect ratio, suitable as a small desktop mascot.'
  const referenceBlock = args.referenceImagePath
    ? await readReferenceImageBlock(args.referenceImagePath)
    : null

  if (!referenceBlock) {
    return await requestPetSpriteImage(args.provider, fullPrompt)
  }

  try {
    return await requestPetSpriteImage(args.provider, [
      referenceBlock,
      { type: 'text', text: fullPrompt }
    ])
  } catch (error) {
    const fallback = await requestPetSpriteImage(args.provider, fullPrompt)
    return {
      ...fallback,
      usedTextFallback: true,
      fallbackReason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function requestPetSpriteImage(
  provider: ProviderConfig,
  content: string | ContentBlock[]
): Promise<{ data: string; mediaType: string }> {
  const messages: UnifiedMessage[] = [
    {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: Date.now()
    }
  ]
  let imageError: string | null = null

  for await (const event of streamNativeOpenAIImages({ messages, config: provider })) {
    switch (event.type) {
      case 'image_generated': {
        const source = event.imageBlock?.source
        if (source?.type === 'base64' && source.data) {
          return { data: source.data, mediaType: source.mediaType ?? 'image/png' }
        }
        break
      }
      case 'image_error':
        imageError = event.imageError?.message ?? 'Image generation failed.'
        break
      default:
        break
    }
  }

  throw new Error(imageError ?? 'Native image generation returned no image output.')
}

function resolvePetImageProviderConfig(): ProviderConfig | null {
  const store = useProviderStore.getState()
  const active = store.getImageProviderConfig()
  if (active) return active

  for (const provider of store.providers) {
    if (provider.enabled === false) continue
    const model = provider.models.find(
      (item) => item.enabled !== false && (item.category ?? 'chat') === 'image'
    )
    if (!model) continue
    const config = store.getProviderConfigById(provider.id, model.id)
    if (config) return config
  }

  return null
}

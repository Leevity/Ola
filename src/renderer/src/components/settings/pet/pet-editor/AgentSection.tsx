import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Loader2, Play, RotateCcw, Volume2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { usePetsStore, type Pet, type PetProactiveFreq } from '@renderer/stores/pets-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { BUILTIN_PET_PROMPT } from '@renderer/lib/pet/pet-agent'
import { PET_VOICE_PRESETS, playPetVoice } from '@renderer/lib/pet/pet-voice'
import type { PetVoiceMode } from '@renderer/stores/pet-agent-store'
import { isDefaultPet, updateDefaultPetAgent } from '@renderer/lib/pet/default-pet-sync'

const PROJECT_NONE = '__none__'
const VOICE_DEFAULT = '__default__'
const VOICE_CUSTOM = '__custom__'
const ALL_VOICE_PRESETS = [...PET_VOICE_PRESETS.openai, ...PET_VOICE_PRESETS.mimo]

function toOptionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function fromOptionValue(value: string): [string, string] {
  const index = value.indexOf('::')
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 2)]
}

interface AgentSectionProps {
  pet: Pet
}

export function AgentSection({ pet }: AgentSectionProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const providers = useProviderStore((s) => s.providers)
  const projects = useChatStore((s) => s.projects)
  const setPetAgent = usePetsStore((s) => s.setPetAgent)
  const agent = pet.agent

  const [selection, setSelection] = useState(
    agent.providerId && agent.modelId ? toOptionValue(agent.providerId, agent.modelId) : ''
  )
  const [promptDraft, setPromptDraft] = useState(agent.systemPrompt)
  const [projectDraft, setProjectDraft] = useState(agent.projectId ?? PROJECT_NONE)
  const [proactiveDraft, setProactiveDraft] = useState(agent.proactive)
  const [freqDraft, setFreqDraft] = useState<PetProactiveFreq>(agent.proactiveFreq)
  const [quietStartDraft, setQuietStartDraft] = useState(String(agent.quietStart))
  const [quietEndDraft, setQuietEndDraft] = useState(String(agent.quietEnd))

  const [voiceEnabledDraft, setVoiceEnabledDraft] = useState(agent.voiceEnabled)
  const [voiceSelection, setVoiceSelection] = useState(
    agent.voiceProviderId && agent.voiceModelId
      ? toOptionValue(agent.voiceProviderId, agent.voiceModelId)
      : ''
  )
  const [voiceDraft, setVoiceDraft] = useState(agent.voice)
  const [voiceCustom, setVoiceCustom] = useState(
    agent.voice !== '' && !ALL_VOICE_PRESETS.includes(agent.voice)
  )
  const [voiceModeDraft, setVoiceModeDraft] = useState<PetVoiceMode>(agent.voiceMode)
  const [voiceInstructionDraft, setVoiceInstructionDraft] = useState(agent.voiceInstruction)
  const [voiceTagDraft, setVoiceTagDraft] = useState(agent.voiceTag)
  const [voiceTesting, setVoiceTesting] = useState(false)

  // Re-seed drafts whenever the user switches pets inside the editor — the
  // dialog body stays mounted for typing perf, but the underlying data
  // changes when a different card is opened.
  useEffect(() => {
    setSelection(
      agent.providerId && agent.modelId ? toOptionValue(agent.providerId, agent.modelId) : ''
    )
    setPromptDraft(agent.systemPrompt)
    setProjectDraft(agent.projectId ?? PROJECT_NONE)
    setProactiveDraft(agent.proactive)
    setFreqDraft(agent.proactiveFreq)
    setQuietStartDraft(String(agent.quietStart))
    setQuietEndDraft(String(agent.quietEnd))
    setVoiceEnabledDraft(agent.voiceEnabled)
    setVoiceSelection(
      agent.voiceProviderId && agent.voiceModelId
        ? toOptionValue(agent.voiceProviderId, agent.voiceModelId)
        : ''
    )
    setVoiceDraft(agent.voice)
    setVoiceCustom(agent.voice !== '' && !ALL_VOICE_PRESETS.includes(agent.voice))
    setVoiceModeDraft(agent.voiceMode)
    setVoiceInstructionDraft(agent.voiceInstruction)
    setVoiceTagDraft(agent.voiceTag)
    // Intentionally only depend on pet.id: switching pets re-seeds; in-place
    // edits to the current pet are committed via Save, not draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.id])

  const chatModelGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) => model.enabled && (model.category ?? 'chat') === 'chat'
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const voiceModelGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) =>
              model.enabled &&
              ((model.category ?? 'chat') === 'speech' || /tts|audio/i.test(model.id))
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const testVoice = async (): Promise<void> => {
    const [testProviderId, testModelId] = fromOptionValue(voiceSelection)
    if (!testProviderId || !testModelId) {
      toast.error(t('agent.voiceModelPlaceholder'))
      return
    }
    setVoiceTesting(true)
    try {
      await playPetVoice(
        {
          providerId: testProviderId,
          modelId: testModelId,
          voice: voiceDraft,
          mode: voiceModeDraft,
          instruction: voiceInstructionDraft,
          tag: voiceTagDraft
        },
        t('agent.voiceTestSample', { name: pet.name })
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setVoiceTesting(false)
    }
  }

  const save = (): void => {
    const [nextProviderId, nextModelId] = fromOptionValue(selection)
    const [nextVoiceProviderId, nextVoiceModelId] = fromOptionValue(voiceSelection)
    const project =
      projectDraft === PROJECT_NONE ? null : (projects.find((p) => p.id === projectDraft) ?? null)
    const nextAgent = {
      providerId: nextProviderId || null,
      modelId: nextModelId || null,
      systemPrompt: promptDraft.trim() === BUILTIN_PET_PROMPT.trim() ? '' : promptDraft,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      projectFolder: project?.workingFolder ?? null,
      proactive: proactiveDraft,
      proactiveFreq: freqDraft,
      quietStart: Number(quietStartDraft),
      quietEnd: Number(quietEndDraft),
      voiceEnabled: voiceEnabledDraft,
      voiceProviderId: nextVoiceProviderId || null,
      voiceModelId: nextVoiceModelId || null,
      voice: voiceDraft.trim(),
      voiceMode: voiceModeDraft,
      voiceInstruction: voiceInstructionDraft.trim(),
      voiceTag: voiceTagDraft.trim()
    }
    if (isDefaultPet(pet.id)) {
      updateDefaultPetAgent(nextAgent)
    } else {
      setPetAgent(pet.id, nextAgent)
      void ipcClient.invoke('pet:sync', { kind: 'agent-config', payload: { petId: pet.id } })
    }
    toast.success(t('agent.saved'))
  }

  return (
    <div className="space-y-5 pt-4">
      <p className="text-xs text-muted-foreground">{t('agent.desc')}</p>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-sky-400" />
          <p className="text-sm font-medium">{t('agent.model')}</p>
        </div>
        {chatModelGroups.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
            {t('agent.noChatModels')}
          </p>
        ) : (
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-72">
              <SelectValue placeholder={t('agent.modelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {chatModelGroups.map((group) => (
                <SelectGroup key={group.provider.id}>
                  <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                    {group.provider.name}
                  </SelectLabel>
                  {group.models.map((model) => (
                    <SelectItem
                      key={toOptionValue(group.provider.id, model.id)}
                      value={toOptionValue(group.provider.id, model.id)}
                      className="pl-6 text-xs"
                    >
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('agent.prompt')}</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={() => setPromptDraft('')}
          >
            <RotateCcw className="mr-1 size-3" />
            {t('agent.resetPrompt')}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">{t('agent.promptHint')}</p>
        <Textarea
          rows={6}
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder={BUILTIN_PET_PROMPT}
          className="text-xs"
        />
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('agent.project')}</p>
        <Select value={projectDraft} onValueChange={setProjectDraft}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-72">
            <SelectValue placeholder={t('agent.projectNone')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROJECT_NONE}>{t('agent.projectNone')}</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id} className="text-xs">
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">{t('agent.projectHint')}</p>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('agent.proactive')}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{t('agent.proactiveDesc')}</p>
          </div>
          <Switch checked={proactiveDraft} onCheckedChange={setProactiveDraft} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">{t('agent.proactiveFreq')}</span>
            <Select value={freqDraft} onValueChange={(v) => setFreqDraft(v as PetProactiveFreq)}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['low', 'medium', 'high'] as PetProactiveFreq[]).map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {t(`agent.freq.${f}`, { count: petProactiveDailyCap(f) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">{t('agent.quietHours')}</span>
            <Input
              type="number"
              min={0}
              max={23}
              value={quietStartDraft}
              onChange={(e) => setQuietStartDraft(e.target.value)}
              className="h-7 w-14 text-xs"
            />
            <span className="text-muted-foreground">{t('agent.quietTo')}</span>
            <Input
              type="number"
              min={0}
              max={23}
              value={quietEndDraft}
              onChange={(e) => setQuietEndDraft(e.target.value)}
              className="h-7 w-14 text-xs"
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">{t('agent.proactiveHint')}</p>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-1 text-sm font-medium">
              <Volume2 className="size-4 text-violet-400" />
              {t('agent.voice')}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{t('agent.voiceDesc')}</p>
          </div>
          <Switch checked={voiceEnabledDraft} onCheckedChange={setVoiceEnabledDraft} />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('agent.voiceModel')}</p>
            {voiceModelGroups.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                {t('agent.noVoiceModels')}
              </p>
            ) : (
              <Select value={voiceSelection} onValueChange={setVoiceSelection}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={t('agent.voiceModelPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {voiceModelGroups.map((group) => (
                    <SelectGroup key={group.provider.id}>
                      <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                        {group.provider.name}
                      </SelectLabel>
                      {group.models.map((model) => (
                        <SelectItem
                          key={toOptionValue(group.provider.id, model.id)}
                          value={toOptionValue(group.provider.id, model.id)}
                          className="pl-6 text-xs"
                        >
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('agent.voiceName')}</p>
            <Select
              value={voiceCustom ? VOICE_CUSTOM : voiceDraft || VOICE_DEFAULT}
              onValueChange={(v) => {
                if (v === VOICE_CUSTOM) {
                  setVoiceCustom(true)
                } else {
                  setVoiceCustom(false)
                  setVoiceDraft(v === VOICE_DEFAULT ? '' : v)
                }
              }}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue placeholder={t('agent.voiceDefault')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={VOICE_DEFAULT}>{t('agent.voiceDefault')}</SelectItem>
                {ALL_VOICE_PRESETS.map((v) => (
                  <SelectItem key={v} value={v} className="text-xs">
                    {v}
                  </SelectItem>
                ))}
                <SelectItem value={VOICE_CUSTOM}>{t('agent.voiceCustomOption')}</SelectItem>
              </SelectContent>
            </Select>
            {voiceCustom ? (
              <Input
                value={voiceDraft}
                onChange={(e) => setVoiceDraft(e.target.value)}
                placeholder={t('agent.voiceCustomPlaceholder')}
                className="mt-1 h-8 text-xs"
              />
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('agent.voiceMode')}</p>
            <Select
              value={voiceModeDraft}
              onValueChange={(v) => setVoiceModeDraft(v as PetVoiceMode)}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">
                  {t('agent.voiceModes.auto')}
                </SelectItem>
                <SelectItem value="speech" className="text-xs">
                  {t('agent.voiceModes.speech')}
                </SelectItem>
                <SelectItem value="chat" className="text-xs">
                  {t('agent.voiceModes.chat')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('agent.voiceTag')}</p>
            <Input
              value={voiceTagDraft}
              onChange={(e) => setVoiceTagDraft(e.target.value)}
              placeholder={t('agent.voiceTagPlaceholder')}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[10px] text-muted-foreground">{t('agent.voiceInstruction')}</p>
          <Input
            value={voiceInstructionDraft}
            onChange={(e) => setVoiceInstructionDraft(e.target.value)}
            placeholder={t('agent.voiceInstructionPlaceholder')}
            className="h-8 text-xs"
          />
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">{t('agent.voiceHint')}</p>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={voiceTesting || !voiceSelection}
            onClick={() => void testVoice()}
          >
            {voiceTesting ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Play className="mr-1 size-3" />
            )}
            {t('agent.voiceTest')}
          </Button>
        </div>
      </section>

      <div className="flex justify-end">
        <Button onClick={save}>{t('agent.save')}</Button>
      </div>
    </div>
  )
}

// Inline copy of the proactive cap table so this file stays free of the
// legacy pet-agent-store import (still alive for migration shims).
function petProactiveDailyCap(freq: PetProactiveFreq): number {
  switch (freq) {
    case 'low':
      return 1
    case 'medium':
      return 2
    case 'high':
      return 4
  }
}

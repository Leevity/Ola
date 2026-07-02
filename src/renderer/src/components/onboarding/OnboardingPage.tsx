import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Briefcase,
  Check,
  Code2,
  Compass,
  GraduationCap,
  Handshake,
  Heart,
  HeartPulse,
  Home,
  Languages,
  Loader2,
  Megaphone,
  Palette,
  PenLine,
  Scale,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Wallet
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  LANGUAGE_OPTIONS,
  detectSystemLanguage,
  resolveLanguageLabel,
  resolveLanguageName
} from '@renderer/lib/i18n-language'
import {
  isMissingFileErrorMessage,
  joinFsPath,
  readTextFile,
  resolveGlobalMemoryHomePath
} from '@renderer/lib/agent/memory-files'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore, type OnboardingLanguage } from '@renderer/stores/settings-store'
import {
  DEFAULT_BUILTIN_SOUL_TEMPLATE_ID,
  type BuiltinSoulTemplateWithContent
} from '../../../../shared/builtin-souls'

type OnboardingStep = 'intro' | 'language' | 'nickname' | 'interests' | 'soul'

interface InterestOption {
  id: string
  icon: ComponentType<{ className?: string }>
  soulId?: string
}

const STEPS: OnboardingStep[] = ['intro', 'language', 'nickname', 'interests', 'soul']
const PROFILE_BLOCK_START = '<!-- OLA_ONBOARDING_PROFILE_START -->'
const PROFILE_BLOCK_END = '<!-- OLA_ONBOARDING_PROFILE_END -->'

const INTEREST_OPTIONS: InterestOption[] = [
  { id: 'content', icon: PenLine, soulId: 'research-writing-strategist' },
  { id: 'coding', icon: Code2, soulId: 'senior-engineering-partner' },
  { id: 'design', icon: Palette },
  { id: 'learning', icon: GraduationCap, soulId: 'research-writing-strategist' },
  { id: 'business', icon: Briefcase, soulId: 'product-strategy-operator' },
  { id: 'marketing', icon: Megaphone, soulId: 'product-strategy-operator' },
  { id: 'product', icon: Target, soulId: 'product-strategy-operator' },
  { id: 'sales', icon: Handshake, soulId: 'product-strategy-operator' },
  { id: 'operations', icon: Compass, soulId: 'daily-life-assistant' },
  { id: 'hr', icon: Users, soulId: 'daily-life-assistant' },
  { id: 'financeLaw', icon: Scale, soulId: 'research-writing-strategist' },
  { id: 'creatorEconomy', icon: Wallet, soulId: 'product-strategy-operator' },
  { id: 'investment', icon: BarChart3, soulId: 'research-writing-strategist' },
  { id: 'family', icon: Home, soulId: 'emotionally-attuned-companion' },
  { id: 'health', icon: HeartPulse, soulId: 'daily-life-assistant' },
  { id: 'culture', icon: Heart, soulId: 'emotionally-attuned-companion' },
  { id: 'personal', icon: Home, soulId: 'daily-life-assistant' },
  { id: 'other', icon: BookOpen, soulId: 'balanced-collaborator' }
]

function getStepIndex(step: OnboardingStep): number {
  return Math.max(0, STEPS.indexOf(step))
}

function sanitizeNickname(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80)
}

function readIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getSoulLabelTranslationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function getPreferredSoulId(interestIds: string[]): string {
  for (const interestId of interestIds) {
    const soulId = INTEREST_OPTIONS.find((option) => option.id === interestId)?.soulId
    if (soulId) return soulId
  }
  return DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
}

function buildUserProfileBlock({
  nickname,
  language,
  interestLabels
}: {
  nickname: string
  language: OnboardingLanguage
  interestLabels: string[]
}): string {
  const preferredLanguage = resolveLanguageName(language)
  const interests = interestLabels.length > 0 ? interestLabels.join(', ') : 'Not specified'

  return [
    PROFILE_BLOCK_START,
    '## Ola Profile',
    '',
    `- Name: ${nickname}`,
    `- Preferred language: ${preferredLanguage}`,
    `- Interested domains: ${interests}`,
    '',
    PROFILE_BLOCK_END
  ].join('\n')
}

function upsertUserProfileBlock(existingContent: string, block: string): string {
  const normalized = existingContent.replace(/\r\n/g, '\n').trim()
  const blockPattern = new RegExp(
    `${escapeRegExp(PROFILE_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PROFILE_BLOCK_END)}`
  )

  if (!normalized) {
    return ['# USER.md', '', block, ''].join('\n')
  }

  if (blockPattern.test(normalized)) {
    return `${normalized.replace(blockPattern, block)}\n`
  }

  return `${normalized}\n\n${block}\n`
}

function BrandHeader({
  language,
  onLanguageChange
}: {
  language: OnboardingLanguage
  onLanguageChange: (language: OnboardingLanguage) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')

  return (
    <header className="flex h-14 shrink-0 items-center justify-between px-5">
      <div className="text-base font-semibold text-foreground">Ola</div>
      <Select
        value={language}
        onValueChange={(value) => onLanguageChange(value as OnboardingLanguage)}
      >
        <SelectTrigger
          aria-label={t('onboarding.language.shortLabel')}
          className="h-8 w-[118px] border-transparent bg-transparent text-xs shadow-none hover:bg-muted"
        >
          <Languages className="size-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {LANGUAGE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </header>
  )
}

function OnboardingMark(): React.JSX.Element {
  return (
    <div className="flex size-12 items-center justify-center rounded-lg border bg-background shadow-sm">
      <BrainCircuit className="size-6 text-primary" />
    </div>
  )
}

function StepButton({
  onClick,
  disabled,
  loading,
  children
}: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Button className="h-11 min-w-36 px-6" onClick={onClick} disabled={disabled || loading}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
      {children}
    </Button>
  )
}

export function OnboardingPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('common')
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const persistedLanguage = useSettingsStore((s) => s.language)
  const persistedName = useSettingsStore((s) => s.userName)
  const persistedInterests = useSettingsStore((s) => s.onboardingInterests)
  const persistedSoulId = useSettingsStore((s) => s.defaultSoulTemplateId)
  const [step, setStep] = useState<OnboardingStep>('intro')
  const [language, setLanguage] = useState<OnboardingLanguage>(
    persistedLanguage ?? detectSystemLanguage()
  )
  const [nickname, setNickname] = useState(persistedName)
  const [interestIds, setInterestIds] = useState<string[]>(persistedInterests)
  const [selectedSoulId, setSelectedSoulId] = useState(
    persistedSoulId || DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
  )
  const [soulTemplates, setSoulTemplates] = useState<BuiltinSoulTemplateWithContent[]>([])
  const [loadingSouls, setLoadingSouls] = useState(false)
  const [finishing, setFinishing] = useState(false)

  const stepIndex = getStepIndex(step)
  const selectedSoul = useMemo(
    () =>
      soulTemplates.find((template) => template.id === selectedSoulId) ??
      soulTemplates.find((template) => template.id === DEFAULT_BUILTIN_SOUL_TEMPLATE_ID) ??
      soulTemplates[0] ??
      null,
    [selectedSoulId, soulTemplates]
  )
  const canContinue = useMemo(() => {
    if (step === 'nickname') return sanitizeNickname(nickname).length > 0
    if (step === 'interests') return interestIds.length > 0
    if (step === 'soul') return Boolean(selectedSoul)
    return true
  }, [interestIds.length, nickname, selectedSoul, step])

  const interestLabels = useMemo(
    () =>
      interestIds.map((id) =>
        t(`onboarding.interests.options.${id}`, {
          defaultValue: id
        })
      ),
    [interestIds, t]
  )

  const handleLanguageChange = useCallback(
    (nextLanguage: OnboardingLanguage) => {
      setLanguage(nextLanguage)
      updateSettings({ language: nextLanguage })
      void i18n.changeLanguage(nextLanguage)
    },
    [i18n, updateSettings]
  )

  const loadSoulTemplates = useCallback(async (): Promise<void> => {
    setLoadingSouls(true)
    try {
      const result = (await ipcClient.invoke(IPC.SOULS_BUILTIN_LIST)) as {
        templates?: BuiltinSoulTemplateWithContent[]
        error?: string
      }
      if (result.error) throw new Error(result.error)
      const templates = Array.isArray(result.templates)
        ? result.templates.filter((template) => template.content.trim())
        : []
      setSoulTemplates(templates)
      setSelectedSoulId((current) => {
        if (templates.some((template) => template.id === current)) return current
        if (templates.some((template) => template.id === DEFAULT_BUILTIN_SOUL_TEMPLATE_ID)) {
          return DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
        }
        return templates[0]?.id ?? DEFAULT_BUILTIN_SOUL_TEMPLATE_ID
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('onboarding.soul.loadFailed'), { description: message })
      setSoulTemplates([])
    } finally {
      setLoadingSouls(false)
    }
  }, [t])

  useEffect(() => {
    void loadSoulTemplates()
  }, [loadSoulTemplates])

  const goNext = useCallback(() => {
    if (step === 'interests') {
      const preferred = getPreferredSoulId(interestIds)
      if (soulTemplates.some((template) => template.id === preferred)) {
        setSelectedSoulId(preferred)
      }
    }

    const nextStep = STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]
    setStep(nextStep)
  }, [interestIds, soulTemplates, step, stepIndex])

  const goBack = useCallback(() => {
    const previousStep = STEPS[Math.max(stepIndex - 1, 0)]
    setStep(previousStep)
  }, [stepIndex])

  const toggleInterest = useCallback((id: string) => {
    setInterestIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }, [])

  const writeUserProfile = useCallback(async (): Promise<void> => {
    const rootPath = await resolveGlobalMemoryHomePath(ipcClient)
    if (!rootPath) return

    const userPath = joinFsPath(rootPath, 'USER.md')
    const { content, error } = await readTextFile(ipcClient, userPath)
    if (error && !isMissingFileErrorMessage(error)) {
      throw new Error(error)
    }

    const profileBlock = buildUserProfileBlock({
      nickname: sanitizeNickname(nickname),
      language,
      interestLabels
    })
    const nextContent = upsertUserProfileBlock(content ?? '', profileBlock)
    const writeResult = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
      path: userPath,
      content: nextContent
    })
    const writeError = readIpcError(writeResult)
    if (writeError) throw new Error(writeError)
  }, [interestLabels, language, nickname])

  const finishOnboarding = useCallback(async (): Promise<void> => {
    if (!selectedSoul) return

    setFinishing(true)
    try {
      const installResult = (await ipcClient.invoke(IPC.SOULS_INSTALL, {
        content: selectedSoul.content,
        target: 'global'
      })) as { success: boolean; path?: string; error?: string }

      if (!installResult.success) {
        throw new Error(installResult.error ?? t('onboarding.soul.installFailed'))
      }

      await writeUserProfile()

      updateSettings({
        language,
        userName: sanitizeNickname(nickname),
        onboardingInterests: interestIds,
        defaultSoulTemplateId: selectedSoul.id,
        onboardingCompleted: true,
        onboardingCompletedAt: Date.now()
      })
      toast.success(t('onboarding.done.toast'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('onboarding.done.failed'), { description: message })
    } finally {
      setFinishing(false)
    }
  }, [interestIds, language, nickname, selectedSoul, t, updateSettings, writeUserProfile])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <BrandHeader language={language} onLanguageChange={handleLanguageChange} />

      <main className="flex min-h-0 flex-1 items-center justify-center px-5 py-8">
        <div className="w-full max-w-3xl">
          <div className="mb-10 h-1 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-foreground transition-all duration-300"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
            />
          </div>

          <AnimatePresence mode="wait">
            <motion.section
              key={step}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="min-h-[460px]"
            >
              {step === 'intro' ? (
                <div className="max-w-xl space-y-8">
                  <OnboardingMark />
                  <div className="space-y-3">
                    <h1 className="text-3xl font-semibold">{t('onboarding.intro.title')}</h1>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {t('onboarding.intro.subtitle')}
                    </p>
                  </div>
                  <div className="space-y-5">
                    {(['local', 'team', 'memory'] as const).map((item) => (
                      <div key={item} className="grid grid-cols-[34px_1fr] gap-4">
                        <div className="flex size-8 items-center justify-center rounded-md border bg-background">
                          {item === 'local' ? (
                            <ShieldCheck className="size-4 text-muted-foreground" />
                          ) : item === 'team' ? (
                            <Users className="size-4 text-muted-foreground" />
                          ) : (
                            <Sparkles className="size-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="space-y-1">
                          <h2 className="text-base font-semibold">
                            {t(`onboarding.intro.points.${item}.title`)}
                          </h2>
                          <p className="text-sm text-muted-foreground">
                            {t(`onboarding.intro.points.${item}.desc`)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {step === 'language' ? (
                <div className="max-w-2xl space-y-7">
                  <OnboardingMark />
                  <div className="space-y-3">
                    <h1 className="text-3xl font-semibold">{t('onboarding.language.title')}</h1>
                    <p className="text-sm text-muted-foreground">
                      {t('onboarding.language.detected', {
                        language: resolveLanguageLabel(detectSystemLanguage())
                      })}
                    </p>
                  </div>
                  <Select
                    value={language}
                    onValueChange={(value) => handleLanguageChange(value as OnboardingLanguage)}
                  >
                    <SelectTrigger className="h-14 w-full max-w-xl px-4 text-base">
                      <Languages className="size-5 text-muted-foreground" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {step === 'nickname' ? (
                <div className="max-w-2xl space-y-7">
                  <OnboardingMark />
                  <div className="space-y-3">
                    <h1 className="text-3xl font-semibold">{t('onboarding.nickname.title')}</h1>
                    <p className="text-sm text-muted-foreground">
                      {t('onboarding.nickname.subtitle')}
                    </p>
                  </div>
                  <div className="relative max-w-xl">
                    <Input
                      value={nickname}
                      onChange={(event) => setNickname(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && sanitizeNickname(nickname)) goNext()
                      }}
                      autoFocus
                      className="h-16 rounded-lg pl-14 pr-14 text-2xl font-semibold shadow-sm md:text-2xl"
                      placeholder={t('onboarding.nickname.placeholder')}
                    />
                    <PenLine className="absolute left-5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
                    <Button
                      size="icon-sm"
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      onClick={goNext}
                      disabled={!sanitizeNickname(nickname)}
                    >
                      <Send className="size-4" />
                    </Button>
                  </div>
                </div>
              ) : null}

              {step === 'interests' ? (
                <div className="space-y-7">
                  <OnboardingMark />
                  <div className="space-y-3">
                    <h1 className="text-3xl font-semibold">{t('onboarding.interests.title')}</h1>
                    <p className="text-sm text-muted-foreground">
                      {t('onboarding.interests.subtitle')}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {INTEREST_OPTIONS.map((option) => {
                      const Icon = option.icon
                      const selected = interestIds.includes(option.id)
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggleInterest(option.id)}
                          className={cn(
                            'flex h-12 items-center gap-3 rounded-lg border px-4 text-left text-sm font-medium transition-colors',
                            selected
                              ? 'border-foreground bg-foreground text-background'
                              : 'bg-background hover:bg-muted'
                          )}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">
                            {t(`onboarding.interests.options.${option.id}`)}
                          </span>
                          {selected ? <Check className="ml-auto size-4 shrink-0" /> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {step === 'soul' ? (
                <div className="space-y-7">
                  <OnboardingMark />
                  <div className="space-y-3">
                    <h1 className="text-3xl font-semibold">{t('onboarding.soul.title')}</h1>
                    <p className="text-sm text-muted-foreground">{t('onboarding.soul.subtitle')}</p>
                  </div>
                  {loadingSouls ? (
                    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {t('onboarding.soul.loading')}
                    </div>
                  ) : soulTemplates.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
                      <BrainCircuit className="size-6 text-muted-foreground" />
                      <p className="text-sm font-medium">{t('onboarding.soul.empty')}</p>
                      <Button variant="outline" size="sm" onClick={() => void loadSoulTemplates()}>
                        {t('onboarding.soul.retry')}
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {soulTemplates.map((template) => {
                        const selected = selectedSoul?.id === template.id
                        const templateName = t(`builtinSouls.templates.${template.id}.name`, {
                          defaultValue: template.name
                        })
                        const templateDescription = t(
                          `builtinSouls.templates.${template.id}.description`,
                          {
                            defaultValue: template.description
                          }
                        )
                        const templateCategory = t(
                          `builtinSouls.categories.${getSoulLabelTranslationKey(template.category)}`,
                          {
                            defaultValue: template.category
                          }
                        )
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => setSelectedSoulId(template.id)}
                            className={cn(
                              'min-h-32 rounded-lg border p-4 text-left transition-colors',
                              selected
                                ? 'border-foreground bg-foreground text-background'
                                : 'bg-background hover:bg-muted'
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h2 className="truncate text-sm font-semibold">{templateName}</h2>
                                <p
                                  className={cn(
                                    'mt-1 line-clamp-2 text-xs leading-5',
                                    selected ? 'text-background/75' : 'text-muted-foreground'
                                  )}
                                >
                                  {templateDescription}
                                </p>
                              </div>
                              {selected ? <BadgeCheck className="size-5 shrink-0" /> : null}
                            </div>
                            <div className="mt-4 flex flex-wrap gap-1.5">
                              <Badge variant={selected ? 'secondary' : 'outline'}>
                                {templateCategory}
                              </Badge>
                              {template.tags.slice(0, 2).map((tag) => (
                                <Badge key={tag} variant={selected ? 'secondary' : 'outline'}>
                                  {t(`builtinSouls.tags.${getSoulLabelTranslationKey(tag)}`, {
                                    defaultValue: tag
                                  })}
                                </Badge>
                              ))}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </motion.section>
          </AnimatePresence>

          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={stepIndex === 0 || finishing}
              className={cn('text-muted-foreground', stepIndex === 0 && 'invisible')}
            >
              <ArrowLeft className="size-4" />
              {t('onboarding.back')}
            </Button>

            {step === 'soul' ? (
              <StepButton
                onClick={() => void finishOnboarding()}
                disabled={!canContinue}
                loading={finishing}
              >
                {t('onboarding.done.action')}
              </StepButton>
            ) : (
              <StepButton onClick={goNext} disabled={!canContinue}>
                {step === 'intro' ? t('onboarding.start') : t('onboarding.next')}
                <ArrowRight className="size-4" />
              </StepButton>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

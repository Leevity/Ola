const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Revalidates the account-bound team directory even when no UI request arrives. */
export class OfflineWorkspaceExpiryMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private revision = 0
  private expiredAt: number | null = null

  constructor(
    private readonly readExpiresAt: () => Promise<number | null>,
    private readonly refreshIds: () => Promise<ReadonlySet<string>>,
    private readonly revokeUnavailable: (ids: ReadonlySet<string>) => void
  ) {}

  refreshSchedule(): void {
    const revision = ++this.revision
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.readExpiresAt().then(
      (expiresAt) => {
        if (revision !== this.revision || expiresAt === null) return
        this.arm(expiresAt, revision)
      },
      () => {
        if (revision === this.revision) this.revokeUnavailable(new Set())
      }
    )
  }

  private arm(expiresAt: number, revision: number): void {
    if (revision !== this.revision) return
    // An expired directory keeps reporting the same timestamp, so re-arming on it would
    // re-read the directory (and re-run revocation) as fast as a zero-delay timer allows.
    if (this.expiredAt === expiresAt) return
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - Date.now()))
    this.timer = setTimeout(() => {
      this.timer = null
      if (revision !== this.revision) return
      if (Date.now() < expiresAt) {
        this.arm(expiresAt, revision)
        return
      }
      this.expiredAt = expiresAt
      void this.refreshIds().then(
        (ids) => {
          if (revision !== this.revision) return
          this.revokeUnavailable(ids)
          this.refreshSchedule()
        },
        () => {
          if (revision === this.revision) this.revokeUnavailable(new Set())
        }
      )
    }, delay)
    this.timer.unref?.()
  }

  stop(): void {
    this.revision++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

type ObjectRecord = Record<string, unknown>

export interface StoredProviderCredentials {
  apiKey?: string
  oauth?: ObjectRecord
  channel?: ObjectRecord
  accounts?: Record<string, ObjectRecord>
}

function record(value: unknown): ObjectRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectRecord)
    : null
}

function stateBucket(raw: unknown): { root: ObjectRecord; state: ObjectRecord } | null {
  const root = record(raw)
  if (!root) return null
  const state = 'state' in root ? record(root.state) : root
  return state ? { root, state } : null
}

function withProviders(raw: unknown, transform: (provider: ObjectRecord) => ObjectRecord): unknown {
  const bucket = stateBucket(raw)
  if (!bucket || !Array.isArray(bucket.state.providers)) return raw
  const providers = bucket.state.providers.map((item) => {
    const provider = record(item)
    return provider ? transform(provider) : item
  })
  const state = { ...bucket.state, providers }
  return bucket.root === bucket.state ? state : { ...bucket.root, state }
}

/** Keeps only non-secret provider metadata in the legacy config bucket. */
export function splitProviderCredentials(raw: unknown): {
  publicState: unknown
  credentials: Record<string, StoredProviderCredentials>
} {
  const credentials: Record<string, StoredProviderCredentials> = Object.create(null)
  const publicState = withProviders(raw, (provider) => {
    if (typeof provider.id !== 'string' || !provider.id.trim()) return provider
    const publicProvider: ObjectRecord = { ...provider }
    const secret: StoredProviderCredentials = {}
    if (typeof provider.apiKey === 'string' && provider.apiKey) {
      secret.apiKey = provider.apiKey
      publicProvider.apiKey = ''
      publicProvider.apiKeyStored = true
    }
    if (record(provider.oauth)) {
      secret.oauth = provider.oauth as ObjectRecord
      delete publicProvider.oauth
      publicProvider.oauthStored = true
    }
    if (record(provider.channel)) {
      secret.channel = provider.channel as ObjectRecord
      delete publicProvider.channel
      publicProvider.channelStored = true
    }
    if (Array.isArray(provider.oauthAccounts)) {
      const accounts: Record<string, ObjectRecord> = Object.create(null)
      publicProvider.oauthAccounts = provider.oauthAccounts.map((item) => {
        const account = record(item)
        if (!account || typeof account.id !== 'string') return item
        const publicAccount: ObjectRecord = { ...account }
        if (record(account.oauth)) {
          accounts[account.id] = account.oauth as ObjectRecord
          delete publicAccount.oauth
          publicAccount.oauthStored = true
        }
        return publicAccount
      })
      if (Object.keys(accounts).length > 0) secret.accounts = accounts
    }
    if (Object.keys(secret).length > 0) credentials[provider.id] = secret
    return publicProvider
  })
  return { publicState, credentials }
}

/** Restores only fields explicitly marked in public metadata, so deletions stay deleted. */
export function hydrateProviderCredentials(
  raw: unknown,
  credentials: Record<string, StoredProviderCredentials>
): unknown {
  return withProviders(raw, (provider) => {
    if (typeof provider.id !== 'string') return provider
    const secret = credentials[provider.id]
    const hydrated: ObjectRecord = { ...provider }
    if (hydrated.apiKeyStored === true) {
      if (!secret?.apiKey) throw new Error('Provider credential bundle is missing an API key')
      hydrated.apiKey = secret.apiKey
    }
    if (hydrated.oauthStored === true) {
      if (!secret?.oauth) throw new Error('Provider credential bundle is missing an OAuth token')
      hydrated.oauth = secret.oauth
    }
    if (hydrated.channelStored === true) {
      if (!secret?.channel) throw new Error('Provider credential bundle is missing channel auth')
      hydrated.channel = secret.channel
    }
    delete hydrated.apiKeyStored
    delete hydrated.oauthStored
    delete hydrated.channelStored
    if (Array.isArray(provider.oauthAccounts)) {
      hydrated.oauthAccounts = provider.oauthAccounts.map((item) => {
        const account = record(item)
        if (!account) return item
        const next: ObjectRecord = { ...account }
        if (account.oauthStored === true && typeof account.id === 'string') {
          const token = secret?.accounts?.[account.id]
          if (!token) throw new Error('Provider credential bundle is missing an account token')
          next.oauth = token
        }
        delete next.oauthStored
        return next
      })
    }
    return hydrated
  })
}

export interface WebSearchSecretResolver {
  get(): Promise<string>
  set(value: unknown): Promise<unknown>
}

export interface LegacyWebSearchSecretStore {
  readLegacyApiKey(): Promise<string>
  clearLegacyApiKey(): Promise<void>
}

/**
 * Imports a legacy UI value only when Main has no secret, then returns the
 * Main-owned value. Callers must discard the legacy input before forwarding a
 * request to a provider or transition Worker.
 */
export async function resolveWebSearchSecret(
  secrets: WebSearchSecretResolver,
  legacyValue: unknown
): Promise<string> {
  let secret = await secrets.get()
  if (!secret && typeof legacyValue === 'string' && legacyValue.trim()) {
    await secrets.set(legacyValue)
    secret = await secrets.get()
  }
  return secret
}

/**
 * Move the legacy renderer-persisted key into Main-owned encrypted storage.
 * The plaintext is only removed after the encrypted write succeeds. If a
 * newer Main secret already exists, the old value is simply discarded.
 */
export async function migrateLegacyWebSearchSecret(
  secrets: WebSearchSecretResolver,
  legacy: LegacyWebSearchSecretStore
): Promise<void> {
  const legacyKey = (await legacy.readLegacyApiKey()).trim()
  if (!legacyKey) return
  if (!(await secrets.get())) await secrets.set(legacyKey)
  await legacy.clearLegacyApiKey()
}

export async function withMainOwnedWebSearchSecret(
  secrets: WebSearchSecretResolver,
  params: unknown
): Promise<unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params
  const record = params as Record<string, unknown>
  const webSearch = record.webSearch
  if (!webSearch || typeof webSearch !== 'object' || Array.isArray(webSearch)) return params
  const config = webSearch as Record<string, unknown>
  if (config.enabled !== true) return params
  const secret = await resolveWebSearchSecret(secrets, config.apiKey)
  const { apiKey: _rendererApiKey, ...publicConfig } = config
  return {
    ...record,
    webSearch: { ...publicConfig, ...(secret ? { apiKey: secret } : {}) }
  }
}

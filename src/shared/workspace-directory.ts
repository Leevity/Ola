function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4096 ? value : undefined
}

// Explicit allowlists prevent future server fields (including credentials) crossing IPC.
export function publicWorkspaceDirectory(value: unknown) {
  const rows = record(value).workspaces
  return {
    workspaces: (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const item = record(row)
      const id = text(item.id)
      if (!id || (item.kind !== 'personal' && item.kind !== 'team')) return []
      return [
        {
          id,
          kind: item.kind,
          name: text(item.name) ?? id,
          role: ['owner', 'team_admin', 'member'].includes(String(item.role))
            ? item.role
            : 'member',
          revision: text(item.revision)
        }
      ]
    })
  }
}

export function publicModelDirectory(value: unknown) {
  const rows = record(value).resources
  return {
    resources: (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const item = record(row)
      const id = text(item.id)
      const model = text(item.model)
      if (!id || !model) return []
      return [
        {
          id,
          model,
          providerName: text(item.providerName) ?? text(item.provider) ?? 'Ola',
          displayName: text(item.displayName),
          enabled: item.enabled === true,
          isDefault: item.isDefault === true,
          supportsVision: item.supportsVision === true,
          supportsFunctionCall: item.supportsFunctionCall === true,
          category: ['chat', 'image', 'embedding', 'speech'].includes(String(item.category))
            ? item.category
            : 'chat',
          ...(item.protocol === 'openai-chat' || item.protocol === 'openai-responses'
            ? { protocol: item.protocol }
            : {}),
          revision: text(item.revision)
        }
      ]
    })
  }
}

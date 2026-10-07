import type { IPCChannel } from './contract'

export type TypedIpcInvoke = <T = unknown>(channel: IPCChannel, ...args: unknown[]) => Promise<T>

export type TypedIpcSend = (channel: IPCChannel, ...args: unknown[]) => void
export type TypedIpcListener = (
  channel: IPCChannel,
  listener: (...args: unknown[]) => void
) => () => void

/**
 * Per-channel request/response contract. This is the evolving registry that
 * pins down the payload shape for every registered channel. Entries default
 * to `unknown` until a handler is typed; adding a channel here is required
 * before strict typing is enforced for that channel.
 */
export interface IpcChannelSchema {
  request: unknown
  response: unknown
}

export const ipcChannelSchema: Record<string, IpcChannelSchema> = {
  'db:pending-session-queue:get': {
    request: { sessionId: 'string', workspaceId: 'string' },
    response: 'PendingSessionQueueMessage[]'
  },
  'db:pending-session-queue:replace': {
    request: {
      sessionId: 'string',
      workspaceId: 'string',
      messages: 'PendingSessionQueueMessage[]'
    },
    response: 'boolean'
  },
  'settings:get': { request: { key: 'string' }, response: { value: 'unknown' } },
  'settings:set': { request: { key: 'string', value: 'unknown' }, response: { ok: 'boolean' } },
  'db:messages:list': {
    request: { sessionId: 'string', cursor: 'string | undefined' },
    response: { messages: 'UnifiedMessage[]' }
  },
  'db:messages:update': {
    request: { messageId: 'string', patch: 'unknown' },
    response: { ok: 'boolean' }
  },
  'remote:session:list': {
    request: { workspaceId: 'string' },
    response: { sessions: 'Session[]' }
  },
  'fs:read-file': { request: { path: 'string' }, response: { content: 'string' } },
  'fs:write-file': { request: { path: 'string', content: 'string' }, response: { ok: 'boolean' } },
  'shell:exec': {
    request: { command: 'string', cwd: 'string | undefined' },
    response: { output: 'string' }
  },
  'shell:abort': { request: { runId: 'string' }, response: { ok: 'boolean' } },
  'browser:execute-script': {
    request: { target: 'unknown', script: 'string' },
    response: { result: 'unknown' }
  },
  'credentials:store': {
    request: { credentialId: 'string', secret: 'string' },
    response: { ok: 'boolean' }
  },
  'credentials:fill-password': {
    request: { credentialId: 'string', target: 'string' },
    response: { ok: 'boolean' }
  },
  'git:get-status': { request: { workspaceId: 'string' }, response: { status: 'unknown' } },
  'image:download': { request: { url: 'string' }, response: { data: 'unknown' } },
  'notify:session': { request: { title: 'string', body: 'string' }, response: { ok: 'boolean' } },
  'mcp:list-tools': { request: {}, response: { tools: 'unknown[]' } },
  // --- High-risk channels: shell / fs / credentials / browser / process / terminal / desktop / exec ---
  // Shell
  'shell:openPath': { request: { path: 'string' }, response: { error: 'string' } },
  'shell:showItemInFolder': {
    request: { path: 'string' },
    response: { success: 'boolean | error: string' }
  },
  'shell:trashPath': {
    request: { path: 'string' },
    response: { success: 'boolean | error: string' }
  },
  'shell:openWithApp': {
    request: { path: 'string', appId: "'vscode'" },
    response: { success: 'boolean | error: string' }
  },
  'shell:openExternal': { request: { url: 'string' }, response: {} },
  // File system
  'fs:select-file': {
    request: {
      filters: 'Electron.FileFilter[] | undefined',
      multiSelections: 'boolean | undefined'
    },
    response: { path: 'string', paths: 'string[] | canceled: true' }
  },
  'fs:select-save-file': {
    request: { defaultPath: 'string | undefined', filters: 'Electron.FileFilter[] | undefined' },
    response: { path: 'string | canceled: true' }
  },
  'fs:read-document': {
    request: { path: 'string' },
    response: { content: 'string | null', name: 'string | null', error: 'string | null' }
  },
  'fs:read-text-file-lines': {
    request: { path: 'string', maxLines: 'number | undefined' },
    response: {
      content: 'string',
      name: 'string',
      path: 'string',
      lineCount: 'number',
      maxLines: 'number',
      truncated: 'boolean | error: string'
    }
  },
  'fs:stat-path': {
    request: { path: 'string' },
    response: {
      exists: 'boolean',
      type: "'file' | 'directory' | 'other' | null",
      size: 'number | null',
      mtimeMs: 'number | null',
      error: 'string | null | error: string'
    }
  },
  'fs:list-dir': {
    request: { path: 'string', ignore: 'string[] | undefined', limit: 'number | undefined' },
    response: {
      entries: "{ name: string; type: 'file' | 'directory'; path: string }[] | error: string"
    }
  },
  'fs:mkdir': { request: { path: 'string' }, response: { success: 'true | error: string' } },
  'fs:delete': { request: { path: 'string' }, response: { success: 'true | error: string' } },
  'fs:move': {
    request: { from: 'string', to: 'string' },
    response: { success: 'true | error: string' }
  },
  'fs:select-folder': {
    request: { defaultPath: 'string | undefined' },
    response: { path: 'string | canceled: true' }
  },
  'fs:glob': {
    request: {
      pattern: 'string',
      path: 'string | undefined',
      limit: 'number | undefined',
      hidden: 'boolean | undefined',
      respectGitignore: 'boolean | undefined',
      followSymlinks: 'boolean | undefined',
      maxDepth: 'number | undefined'
    },
    response: {
      kind: "'glob'",
      matches: "{ path: string; type?: 'file' | 'directory' }[]",
      meta: 'SearchMeta',
      error: 'string | undefined'
    }
  },
  'fs:grep': {
    request: {
      pattern: 'string',
      path: 'string | undefined',
      include: 'string | undefined',
      exclude: 'string | undefined'
    },
    response: {
      kind: "'grep'",
      matches: 'LocalGrepMatch[]',
      meta: 'unknown',
      output: 'string',
      error: 'string | undefined'
    }
  },
  'fs:watch-file': {
    request: { path: 'string' },
    response: { success: 'true', path: 'string | error: string' }
  },
  'fs:unwatch-file': { request: { path: 'string' }, response: { success: 'true' } },
  'fs:read-file-binary': {
    request: { path: 'string' },
    response: { data: 'string | error: string' }
  },
  'fs:write-file-binary': {
    request: { path: 'string', data: 'string' },
    response: { success: 'true | error: string' }
  },
  'fs:watch-dir': {
    request: { path: 'string', recursive: 'boolean | undefined' },
    response: { success: 'true', recursive: 'boolean', watched: 'number | error: string' }
  },
  'fs:unwatch-dir': {
    request: { path: 'string', recursive: 'boolean | undefined' },
    response: { success: 'true' }
  },
  'fs:default-chat-working-folder': { request: {}, response: { path: 'string | error: string' } },
  'fs:import-profile-avatar': {
    request: { previousUrl: 'string | null | undefined' },
    response: { canceled: 'true | error: string | path: string, url: string' }
  },
  'fs:list-desktop-directories': {
    request: {},
    response: {
      desktopPath: 'string',
      directories: '{ name: string; path: string; isDesktop: boolean }[] | error: string'
    }
  },
  'fs:search-files': {
    request: { path: 'string', query: 'string', limit: 'number | undefined' },
    response: { items: '{ path: string; name: string }[] | error: string' }
  },
  // Credentials
  'credentials:vault-status': {
    request: {},
    response: { available: 'boolean', backend: 'string', reason: 'string | undefined' }
  },
  'credentials:list': {
    request: { domain: 'string | undefined', projectId: 'string | undefined' },
    response: { refs: 'CredentialRef[]' }
  },
  'credentials:delete': {
    request: { id: 'string' },
    response: { success: 'boolean', error: 'string | undefined' }
  },
  'credentials:list-templates': { request: {}, response: { templates: 'BuiltinTemplateInfo[]' } },
  'credentials:enable-template': {
    request: {
      templateId: 'string',
      username: 'string',
      password: 'string',
      verify: 'boolean | undefined'
    },
    response: {
      success: 'boolean',
      ref: 'CredentialRef | undefined',
      verification: 'VerificationResult | undefined',
      error: 'string | undefined'
    }
  },
  'credentials:record-verification': {
    request: { id: 'string', result: 'VerificationResult' },
    response: { ref: 'CredentialRef | undefined', error: 'string | undefined' }
  },
  'credentials:update': {
    request: {
      id: 'string',
      username: 'string | undefined',
      password: 'string | undefined',
      notes: 'string | undefined'
    },
    response: { ref: 'CredentialRef | undefined', error: 'string | undefined' }
  },
  // Browser
  'browser:clear-cookies': {
    request: { workspaceId: 'string' },
    response: { success: 'true | success: false, error: string' }
  },
  'browser:export-cookies': {
    request: { workspaceId: 'string' },
    response: {
      success: 'boolean',
      exported: 'number',
      errorKind: 'string | undefined',
      error: 'string | undefined'
    }
  },
  'browser:emulation-status': {
    request: {},
    response: { success: 'true', status: 'unknown | success: false, error: string' }
  },
  'browser:cookie-profiles': { request: {}, response: { success: 'true', profiles: 'unknown[]' } },
  'browser:import-cookies': {
    request: { profileId: 'string', workspaceId: 'string', privacyConfirmed: 'boolean' },
    response: {
      success: 'boolean',
      imported: 'number',
      skipped: 'number',
      failed: 'number',
      errorKind: 'string | undefined',
      error: 'string | undefined'
    }
  },
  'browser:register-tab': {
    request: {
      tabId: 'string',
      workspaceId: 'string',
      profileId: 'string',
      guestWebContentsId: 'number',
      sessionId: 'string | null | undefined',
      projectId: 'string | null | undefined'
    },
    response: { success: 'true | success: false, error: string' }
  },
  'browser:navigate': {
    request: {
      tabId: 'string',
      action: "'back' | 'forward' | 'reload' | 'stop' | 'goto'",
      url: 'string | undefined'
    },
    response: { success: 'true', state: 'unknown | success: false, error: string' }
  },
  'browser:capture-page': {
    request: { guestWebContentsId: 'number', runId: 'string | undefined' },
    response: { success: 'true', screenshot: 'unknown | success: false, error: string' }
  },
  'browser:take-control': {
    request: { tabId: 'string' },
    response: { success: 'true', controller: 'unknown | success: false, error: string' }
  },
  'browser:view-status': { request: {}, response: { enabled: 'boolean' } },
  'browser:view-create': {
    request: {
      tabId: 'string',
      workspaceId: 'string',
      profileId: 'string',
      bounds: '{ x: number; y: number; width: number; height: number }',
      partition: 'string | undefined',
      userAgent: 'string | undefined',
      url: 'string | undefined'
    },
    response: { success: 'true', tabId: 'string', state: 'unknown | success: false, error: string' }
  },
  'browser:view-set-bounds': {
    request: { tabId: 'string', bounds: '{ x: number; y: number; width: number; height: number }' },
    response: { success: 'true | success: false, error: string' }
  },
  'browser:view-navigate': {
    request: {
      tabId: 'string',
      action: "'back' | 'forward' | 'reload' | 'stop' | 'goto'",
      url: 'string | undefined'
    },
    response: { success: 'true', state: 'unknown | success: false, error: string' }
  },
  'browser:view-destroy': {
    request: { tabId: 'string' },
    response: { success: 'boolean | success: false, error: string' }
  },
  'browser:navigate-guest': {
    request: {
      guestWebContentsId: 'number',
      runId: 'string | undefined',
      action: "'back' | 'forward' | 'reload' | 'stop' | 'goto'",
      url: 'string | undefined'
    },
    response: { success: 'true', state: 'unknown | success: false, error: string' }
  },
  'browser:take-guest-run-control': {
    request: { guestWebContentsId: 'number', runId: 'string' },
    response: { success: 'true', controller: 'unknown | success: false, error: string' }
  },
  'browser:take-run-control': {
    request: { tabId: 'string', runId: 'string' },
    response: { success: 'true', controller: 'unknown | success: false, error: string' }
  },
  'browser:unregister-tab': {
    request: { tabId: 'string' },
    response: { success: 'boolean | success: false, error: string' }
  },
  // Process
  'process:spawn': {
    request: {
      command: 'string',
      cwd: 'string | undefined',
      shell: 'string | undefined',
      metadata: 'ProcessMetadata | undefined'
    },
    response: { id: 'string', terminalId: 'string | error: string' }
  },
  'process:kill': { request: { id: 'string' }, response: { success: 'true | error: string' } },
  'process:write': {
    request: { id: 'string', input: 'string', appendNewline: 'boolean | undefined' },
    response: { success: 'true | undefined', error: 'string | undefined' }
  },
  'process:status': {
    request: { id: 'string' },
    response: {
      running: 'boolean',
      port: 'number | undefined',
      metadata: 'ProcessMetadata | undefined',
      createdAt: 'number',
      exitCode: 'number | null | undefined'
    }
  },
  'process:list': { request: {}, response: { processes: 'unknown[]' } },
  // Terminal
  'terminal:create': {
    request: {
      workspaceId: 'string | undefined',
      cwd: 'string | undefined',
      shell: 'string | undefined',
      cols: 'number | undefined',
      rows: 'number | undefined',
      title: 'string | undefined',
      command: 'string | undefined'
    },
    response: {
      id: 'string | undefined',
      workspaceId: 'string | undefined',
      error: 'string | undefined'
    }
  },
  'terminal:input': {
    request: { id: 'string', data: 'string' },
    response: { success: 'true | undefined', error: 'string | undefined' }
  },
  'terminal:resize': {
    request: { id: 'string', cols: 'number', rows: 'number' },
    response: { success: 'true | error: string' }
  },
  'terminal:kill': {
    request: { id: 'string' },
    response: { success: 'true | undefined', error: 'string | undefined' }
  },
  'terminal:get': {
    request: { id: 'string' },
    response: { success: 'true', session: 'unknown | success: false, error: string' }
  },
  'terminal:list': {
    request: { workspaceId: 'string | undefined' },
    response: { sessions: 'unknown[]' }
  },
  // Desktop control
  'desktop:screenshot:capture': {
    request: {},
    response: {
      success: 'boolean',
      error: 'string | undefined',
      width: 'number | undefined',
      height: 'number | undefined',
      data: 'string | undefined'
    }
  },
  'desktop:input:click': {
    request: {
      x: 'number',
      y: 'number',
      button: "'left' | 'right' | 'middle' | undefined",
      action: "'click' | 'double_click' | 'down' | 'up' | undefined"
    },
    response: {
      success: 'true',
      x: 'number',
      y: 'number',
      button: 'string',
      action: 'string | success: false, error: string'
    }
  },
  'desktop:input:type': {
    request: {
      text: 'string | null | undefined',
      key: 'string | null | undefined',
      hotkey: 'string[] | null | undefined',
      action: "'down' | 'up' | null | undefined",
      modifiers: 'string[] | null | undefined'
    },
    response: {
      success: 'true',
      mode: "'text' | 'key' | 'hotkey' | success: false, error: string'"
    }
  },
  'desktop:input:scroll': {
    request: {
      x: 'number | null | undefined',
      y: 'number | null | undefined',
      scrollX: 'number | null | undefined',
      scrollY: 'number | null | undefined'
    },
    response: {
      success: 'true',
      scrollX: 'number',
      scrollY: 'number | success: false, error: string'
    }
  },
  'desktop:input:status': {
    request: {},
    response: { available: 'boolean', error: 'string | undefined' }
  },
  // Execution / plugin / MCP
  'plugin:exec': {
    request: {
      pluginId: 'string',
      action: 'string',
      params: 'Record<string, unknown>',
      workspaceId: 'string'
    },
    response: { result: 'unknown' }
  },
  'mcp:call-tool': {
    request: { serverId: 'string', toolName: 'string', args: 'Record<string, unknown>' },
    response: { success: 'boolean', result: 'unknown | undefined', error: 'string | undefined' }
  }
}

export type IpcRequestOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['request']
  : unknown
export type IpcResponseOf<C extends string> = C extends keyof typeof ipcChannelSchema
  ? (typeof ipcChannelSchema)[C]['response']
  : unknown

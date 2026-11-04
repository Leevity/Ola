/**
 * Canonical contract for the workspace protocol tool names.
 *
 * Both sides of the boundary declare these names: Main validates and executes
 * them (`src/runtime/tools/workspace-tools.ts`), and the Renderer registry
 * exposes them to the prompt catalog and the approval decision. Keeping one
 * copy here is what stops the two declarations from drifting apart.
 *
 * The schema is the contract Main actually enforces, not the richer historical
 * field set the Renderer once advertised. A field Main rejects must not be
 * advertised: the model would send it, validation would fail, and the call
 * would come back as `INVALID_TOOL_INPUT` for no reason the model can see.
 */

export type WorkspaceProtocolInputSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type WorkspaceProtocolTool = {
  name: string
  description: string
  inputSchema: WorkspaceProtocolInputSchema
  effect: 'read' | 'write'
  /** Baseline approval requirement; a host may refine it for a specific run. */
  requiresApproval: boolean
}

const WORKSPACE_PATH_PROPERTY = {
  type: 'string',
  description: 'Absolute path or relative to the working folder'
}

export const WORKSPACE_PROTOCOL_TOOLS = {
  Read: {
    name: 'Read',
    description:
      'Read a UTF-8 text file inside the configured workspace.\n\nUsage:\n- Output is line-numbered as `spaces + line number + tab`, followed by the file content.\n- Use `offset` and `limit` to page through files longer than the default 2000 lines.\n- Always read a file before you edit or overwrite it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: WORKSPACE_PATH_PROPERTY,
        path: { type: 'string', description: 'Alias for file_path' },
        offset: { type: 'integer', minimum: 1, description: 'Start line (1-indexed)' },
        limit: { type: 'integer', minimum: 1, maximum: 2_000, description: 'Lines to read' }
      },
      additionalProperties: false
    },
    effect: 'read',
    requiresApproval: false
  },
  Write: {
    name: 'Write',
    description:
      'Create or replace a UTF-8 text file inside the configured workspace.\n\nUsage:\n- This tool overwrites the existing file at the provided path.\n- If the file already exists, read it first; the write fails when the file was not read.\n- ALWAYS prefer editing existing files. NEVER create files unless they are explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation when the user asks for it.\n- Only use emojis if the user explicitly requests it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: WORKSPACE_PATH_PROPERTY,
        path: { type: 'string', description: 'Alias for file_path' },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['content'],
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  },
  Edit: {
    name: 'Edit',
    description:
      'Replace an exact string in a UTF-8 workspace file.\n\nUsage:\n- When editing text from Read output, preserve the exact indentation as it appears AFTER the line number prefix. That prefix is `spaces + line number + tab`; everything after the tab is the real content. Never include any part of the prefix in `old_string` or `new_string`.\n- ALWAYS prefer editing existing files. NEVER create files unless they are explicitly required.\n- The edit FAILS when `old_string` is not unique; add surrounding context or use `replace_all`.\n- `replace_all` renames or replaces every occurrence, and is the right choice for a repeated identifier.\n- Only use emojis if the user explicitly requests it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: WORKSPACE_PATH_PROPERTY,
        path: { type: 'string', description: 'Alias for file_path' },
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: {
          type: 'string',
          description: 'The replacement text, which must differ from old_string'
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match'
        }
      },
      required: ['old_string', 'new_string'],
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  },
  NotebookEdit: {
    name: 'NotebookEdit',
    description:
      'Edit a Jupyter notebook cell by index or cell_id inside the workspace.\n\nUsage:\n- Identify the cell with `cell_id` or `cell_index`, and choose `mode` (replace, insert or delete).\n- `mode: "insert"` inserts at `cell_index`; the other modes edit or remove the identified cell.\n- Provide `new_source` (or its alias `source`) unless the mode is delete.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description: 'Notebook path, absolute or relative to the working folder'
        },
        file_path: { type: 'string', description: 'Alias for notebook_path' },
        cell_id: { type: 'string', description: 'Cell id to edit' },
        cell_index: {
          type: 'integer',
          minimum: 0,
          maximum: 100_000,
          description: 'Zero-based cell index'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'Edit mode. Defaults to replace.'
        },
        new_source: { type: 'string', description: 'New cell source' },
        source: { type: 'string', description: 'Alias for new_source' },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown', 'raw'],
          description: 'Cell type for inserted or replaced cells'
        }
      },
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  },
  LS: {
    name: 'LS',
    description:
      'List entries inside the configured workspace directory.\n\nUsage:\n- Prefer Glob when you know what filename pattern you are looking for.\n- Results are bounded; use `limit` to page through a large directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (absolute or relative to the working folder)'
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum entries' }
      },
      additionalProperties: false
    },
    effect: 'read',
    requiresApproval: false
  },
  Glob: {
    name: 'Glob',
    description:
      'Find workspace files with a glob pattern. Returns bounded results and respects .gitignore and common generated directories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files, e.g. **/*.ts' },
        path: {
          type: 'string',
          description: 'Optional search directory (absolute or relative to the working folder)'
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum matches' },
        hidden: { type: 'boolean', description: 'Include hidden files and directories' },
        respectGitignore: {
          type: 'boolean',
          description: 'Respect .gitignore files. Defaults to true.'
        },
        maxDepth: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 50,
          description: 'Maximum directory depth to search'
        }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    effect: 'read',
    requiresApproval: false
  },
  Grep: {
    name: 'Grep',
    description:
      'Search UTF-8 workspace files using a bounded regular expression. Defaults to compact files_with_matches output, skips common generated directories, respects .gitignore unless respectGitignore=false, and caps prompt output. Use output_mode="content" for file:line:text output.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in (absolute or relative to the working folder)'
        },
        glob: { type: 'string', description: 'File glob filter, e.g. **/*.tsx' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum output rows' },
        head_limit: { type: 'integer', minimum: 1, maximum: 200 },
        maxResults: { type: 'integer', minimum: 1, maximum: 200 },
        maxCount: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum matches per file'
        },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching' },
        caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching' },
        smartCase: {
          type: 'boolean',
          description: 'Case-sensitive only when the pattern has uppercase'
        },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string' },
        fixed: { type: 'boolean', description: 'Alias for literal' },
        fixedStrings: { type: 'boolean', description: 'Alias for literal' },
        word: { type: 'boolean', description: 'Match whole words only' },
        line: { type: 'boolean', description: 'Match whole lines only' },
        invertMatch: { type: 'boolean', description: 'Return non-matching lines' },
        output_mode: {
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Output mode. Default files_with_matches.'
        },
        outputMode: {
          enum: ['files_with_matches', 'matches', 'content', 'count'],
          description: 'Legacy output mode alias.'
        }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    effect: 'read',
    requiresApproval: false
  },
  Bash: {
    name: 'Bash',
    description:
      'Run an approved shell command in the configured workspace.\n\nUsage:\n- The tool name does not guarantee bash syntax; follow the shell named in the environment section.\n- Never include `cd`; the working folder is already the working directory.\n- Long-running or serving commands time out; use Monitor when a command must keep running.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: {
          type: 'integer',
          minimum: 1,
          maximum: 120_000,
          description: 'Timeout in milliseconds'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  },
  Monitor: {
    name: 'Monitor',
    description:
      'Run and monitor a command in the configured workspace.\n\nUsage:\n- Use it for a command that must keep running after the call returns.\n- `description` is a short note about what is being monitored.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        description: { type: 'string', maxLength: 512, description: 'Short monitor description' }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  },
  PowerShell: {
    name: 'PowerShell',
    description:
      'Execute a command through Windows PowerShell in the configured workspace.\n\nUsage:\n- Prefer it over Bash only on Windows, when the command needs PowerShell syntax.\n- Never include `cd`; the working folder is already the working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: {
          type: 'integer',
          minimum: 1,
          maximum: 3_600_000,
          description: 'Timeout in milliseconds'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    effect: 'write',
    requiresApproval: true
  }
} satisfies Record<string, WorkspaceProtocolTool>

export const WORKSPACE_PROTOCOL_TOOL_NAMES = Object.keys(WORKSPACE_PROTOCOL_TOOLS) as Array<
  keyof typeof WORKSPACE_PROTOCOL_TOOLS
>

/**
 * The model-facing payload the Renderer registers. Execution stays in Main, so
 * the Renderer only contributes the definition; deriving it here is what keeps
 * the prompt catalog identical to the schema Main validates.
 */
export function workspaceToolDefinition(spec: WorkspaceProtocolTool): {
  name: string
  description: string
  inputSchema: WorkspaceProtocolInputSchema
} {
  return { name: spec.name, description: spec.description, inputSchema: spec.inputSchema }
}

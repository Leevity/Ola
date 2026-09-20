import { readFile, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_BUFFER_BYTES = 256 * 1024
const MAX_FILE_BYTES = 64 * 1024

type WriteInput = { content: string }
type EditInput = { old_string: string; new_string: string }
type ReadInput = Record<string, never>
type FileReadInput = { file_path: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value
}

function writeInput(value: unknown): WriteInput {
  const input = object(value)
  if (Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'content'))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { content: text(input.content, MAX_BUFFER_BYTES) }
}

function editInput(value: unknown): EditInput {
  const input = object(value)
  if (
    Object.keys(input).length !== 2 ||
    typeof input.old_string !== 'string' ||
    typeof input.new_string !== 'string' ||
    !input.old_string ||
    input.old_string.length > MAX_BUFFER_BYTES ||
    input.new_string.length > MAX_BUFFER_BYTES
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { old_string: input.old_string, new_string: input.new_string }
}

function readInput(value: unknown): ReadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {}
}

function fileReadInput(value: unknown): FileReadInput {
  const input = object(value)
  if (
    Object.keys(input).length !== 1 ||
    typeof input.file_path !== 'string' ||
    !input.file_path.trim() ||
    input.file_path.length > 4096
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return { file_path: input.file_path }
}

async function confinedFile(root: string, requested: string): Promise<string> {
  const rootPath = await realpath(root).catch(() => {
    throw new RuntimeError('FILE_READ_UNAVAILABLE')
  })
  const requestedPath = resolve(rootPath, requested)
  const lexical = relative(rootPath, requestedPath)
  if (lexical === '..' || lexical.startsWith(`..${sep}`))
    throw new RuntimeError('TOOL_PATH_FORBIDDEN')
  const target = await realpath(requestedPath).catch(() => {
    throw new RuntimeError('FILE_READ_UNAVAILABLE')
  })
  const outside = relative(rootPath, target)
  if (outside === '..' || outside.startsWith(`..${sep}`))
    throw new RuntimeError('TOOL_PATH_FORBIDDEN')
  return target
}

function bufferResult(content: string): Record<string, unknown> {
  return { __olaTranslationBufferUpdate: true, content }
}

/** Main-owned, per-run translation buffer. It never writes the user's files. */
export function createTranslationRuntimeTools(): ToolDefinition[] {
  let buffer = ''
  return [
    {
      name: 'Write',
      description: 'Replace the complete in-memory translation buffer. Never writes a user file.',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', maxLength: MAX_BUFFER_BYTES } },
        required: ['content'],
        additionalProperties: false
      },
      effect: 'write',
      validate: writeInput,
      resources: async (_value, context) => [`translation-buffer:${context.run.runId}`],
      execute: async (value) => {
        buffer = (value as WriteInput).content
        return bufferResult(buffer)
      }
    },
    {
      name: 'Edit',
      description: 'Replace an exact substring in the in-memory translation buffer.',
      inputSchema: {
        type: 'object',
        properties: {
          old_string: { type: 'string', minLength: 1 },
          new_string: { type: 'string' }
        },
        required: ['old_string', 'new_string'],
        additionalProperties: false
      },
      effect: 'write',
      validate: editInput,
      resources: async (_value, context) => [`translation-buffer:${context.run.runId}`],
      execute: async (value) => {
        const input = value as EditInput
        if (!buffer.includes(input.old_string)) throw new RuntimeError('TRANSLATION_TEXT_NOT_FOUND')
        buffer = buffer.replace(input.old_string, input.new_string)
        if (new TextEncoder().encode(buffer).byteLength > MAX_BUFFER_BYTES)
          throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
        return bufferResult(buffer)
      }
    },
    {
      name: 'Read',
      description: 'Read the current in-memory translation buffer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      validate: readInput,
      resources: async (_value, context) => [`translation-buffer:${context.run.runId}`],
      execute: async () => buffer
    },
    {
      name: 'FileRead',
      description: 'Read a UTF-8 source file inside the selected translation folder.',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
        additionalProperties: false
      },
      effect: 'read',
      validate: fileReadInput,
      resources: async (value, context) => {
        const root = context.run.translationContext?.fileRoot
        if (!root) throw new RuntimeError('FILE_READ_UNAVAILABLE')
        return [await confinedFile(root, (value as FileReadInput).file_path)]
      },
      execute: async (value, context) => {
        const root = context.run.translationContext?.fileRoot
        if (!root) throw new RuntimeError('FILE_READ_UNAVAILABLE')
        const data = await readFile(await confinedFile(root, (value as FileReadInput).file_path))
        if (data.byteLength > MAX_FILE_BYTES) throw new RuntimeError('TOOL_OUTPUT_TOO_LARGE')
        return data.toString('utf8')
      }
    }
  ]
}

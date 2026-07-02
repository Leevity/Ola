import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  decodeStructuredToolResult,
  encodeStructuredToolResult
} from '@renderer/lib/tools/tool-result-format'
import type { ExtensionToolResult } from '../../../../shared/extension-types'

function contentAsText(content?: ToolResultContent): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
  return text || null
}

export function encodeExtensionToolResult(
  result: Omit<ExtensionToolResult, '__openCoworkExtensionResult'>
): string {
  return encodeStructuredToolResult({
    __openCoworkExtensionResult: true,
    ...result
  })
}

export function parseExtensionToolResult(content?: ToolResultContent): ExtensionToolResult | null {
  const text = contentAsText(content)
  if (!text) return null
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed)) return null
  if (parsed.__openCoworkExtensionResult !== true) return null
  if (typeof parsed.extensionId !== 'string') return null
  return parsed as unknown as ExtensionToolResult
}

export function isExtensionToolName(name: string): boolean {
  return name.startsWith('extension__')
}

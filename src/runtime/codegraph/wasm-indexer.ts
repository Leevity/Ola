import type { Node } from 'web-tree-sitter'
import { withWasmSyntaxTree, type WasmCodeGraphLanguage } from './wasm-parser'

export type WasmSymbolKind = 'class' | 'function' | 'method' | 'interface' | 'type' | 'variable'

export interface WasmCodeGraphSymbol {
  name: string
  kind: WasmSymbolKind
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  exported: boolean
}

export interface WasmCodeGraphImport {
  source: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface WasmCodeGraphReference {
  name: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface WasmFileIndex {
  language: WasmCodeGraphLanguage
  hasParseError: boolean
  symbols: WasmCodeGraphSymbol[]
  imports: WasmCodeGraphImport[]
  references: WasmCodeGraphReference[]
}

const TYPE_KIND: Readonly<Record<string, WasmSymbolKind>> = {
  class_declaration: 'class',
  class_definition: 'class',
  class_specifier: 'class',
  contract_declaration: 'class',
  interface_declaration: 'interface',
  interface_definition: 'interface',
  type_alias_declaration: 'type',
  type_definition: 'type',
  function_declaration: 'function',
  function_definition: 'function',
  function: 'function',
  function_definition_item: 'function',
  function_item: 'function',
  method: 'method',
  method_definition: 'method',
  method_declaration: 'method',
  method_definition_item: 'method',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
  variable_declarator: 'variable',
  variable_name: 'variable',
  field_declaration: 'variable'
}

const IMPORT_NODE_TYPES = new Set([
  'import_statement',
  'import_declaration',
  'import_from_statement',
  'using_directive',
  'use_declaration'
])

function declarationName(node: Node): string | undefined {
  const field = node.childForFieldName('name')
  if (field?.text.trim()) return field.text.trim()
  const direct = node.namedChildren.find((child) => {
    return [
      'identifier',
      'property_identifier',
      'type_identifier',
      'field_identifier',
      'variable'
    ].includes(child?.type ?? '')
  })
  if (direct?.text.trim()) return direct.text.trim()
  if (node.type === 'function_definition') {
    const stack = [...node.namedChildren]
    while (stack.length) {
      const child = stack.shift()!
      if (['identifier', 'variable'].includes(child.type) && child.text.trim())
        return child.text.trim()
      stack.unshift(...child.namedChildren)
    }
  }
  return undefined
}

function isExported(node: Node): boolean {
  if (node.parent?.type === 'export_statement') return true
  return node.text.trimStart().startsWith('export ')
}

function addSymbol(symbols: WasmCodeGraphSymbol[], node: Node, kind: WasmSymbolKind): void {
  const name = declarationName(node)
  if (!name) return
  const start = node.startPosition
  const end = node.endPosition
  symbols.push({
    name,
    kind,
    startLine: start.row + 1,
    startColumn: start.column + 1,
    endLine: end.row + 1,
    endColumn: end.column + 1,
    exported: isExported(node)
  })
}

function unquoteImportSource(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length < 3) return undefined
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return undefined
  const source = trimmed.slice(1, -1)
  return source || undefined
}

function importSource(node: Node): string | undefined {
  const direct = node.childForFieldName('source')
  const literal =
    direct ??
    node.namedChildren.find((child) =>
      ['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal'].includes(
        child?.type ?? ''
      )
    )
  return literal ? unquoteImportSource(literal.text) : undefined
}

function addImport(imports: WasmCodeGraphImport[], node: Node): void {
  const source = importSource(node)
  if (!source) return
  const start = node.startPosition
  const end = node.endPosition
  imports.push({
    source,
    startLine: start.row + 1,
    startColumn: start.column + 1,
    endLine: end.row + 1,
    endColumn: end.column + 1
  })
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent
  if (!parent || !TYPE_KIND[parent.type]) return false
  if (parent.childForFieldName('name')?.id === node.id) return true
  if (parent.type === 'function' || parent.type === 'function_definition') {
    return parent.namedChildren[0]?.id === node.id
  }
  return false
}

function addReference(references: WasmCodeGraphReference[], node: Node): void {
  if (!['identifier', 'variable', 'variable_name'].includes(node.type) || isDeclarationName(node))
    return
  const parent = node.parent
  // Import module names and member-property labels are not lexical references.
  if (
    parent &&
    (IMPORT_NODE_TYPES.has(parent.type) ||
      parent.type === 'member_expression' ||
      (parent.type === 'call_expression' && parent.parent?.type === 'signature'))
  )
    return
  const start = node.startPosition
  const end = node.endPosition
  references.push({
    name: node.text,
    startLine: start.row + 1,
    startColumn: start.column + 1,
    endLine: end.row + 1,
    endColumn: end.column + 1
  })
}

/**
 * Extracts declaration symbols from the grammar tree without regex fallback.
 * The resulting data is intentionally file-local: cross-file resolution,
 * references, persistence and incremental invalidation remain separate P7
 * work and must not be mixed with unrelated indexing state.
 */
export async function indexWithWasm(
  language: WasmCodeGraphLanguage,
  source: string
): Promise<WasmFileIndex> {
  return await withWasmSyntaxTree(language, source, (root) => {
    const symbols: WasmCodeGraphSymbol[] = []
    const imports: WasmCodeGraphImport[] = []
    const references: WasmCodeGraphReference[] = []
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()!
      const kind = TYPE_KIND[node.type]
      if (kind) addSymbol(symbols, node, kind)
      if (IMPORT_NODE_TYPES.has(node.type)) addImport(imports, node)
      addReference(references, node)
      stack.push(...node.namedChildren.filter((child): child is Node => child !== null))
    }
    symbols.sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.startColumn - right.startColumn ||
        left.name.localeCompare(right.name)
    )
    references.sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.startColumn - right.startColumn ||
        left.name.localeCompare(right.name)
    )
    imports.sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.startColumn - right.startColumn ||
        left.source.localeCompare(right.source)
    )
    return { language, hasParseError: root.hasError, symbols, imports, references }
  })
}

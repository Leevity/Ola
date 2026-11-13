import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'

const MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

const surface = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    color: 'var(--foreground)',
    backgroundColor: 'var(--background)'
  },
  '.cm-scroller': { fontFamily: MONOSPACE, lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'var(--muted-foreground)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'var(--muted)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--muted)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '6px'
  },
  '.cm-tooltip-hover': { maxWidth: '480px' },
  '.ola-editor-hover': { padding: '6px 8px', fontSize: '12px' },
  '.ola-editor-hover pre': {
    margin: '0 0 4px',
    fontFamily: MONOSPACE,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  '.ola-editor-hover div': { color: 'var(--muted-foreground)', whiteSpace: 'pre-wrap' },
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--primary)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--muted)',
    border: 'none',
    color: 'var(--muted-foreground)'
  }
})

const lightTokens = HighlightStyle.define([
  { tag: tags.keyword, color: '#a626a4' },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
    color: '#e45649'
  },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#4078f2' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#986801' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#383a42' },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace
    ],
    color: '#c18401'
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string)
    ],
    color: '#0184bc'
  },
  { tag: [tags.meta, tags.comment], color: '#a0a1a7', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.heading, fontWeight: 'bold', color: '#e45649' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#986801' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#50a14f' },
  { tag: tags.invalid, color: '#ffffff', backgroundColor: '#e45649' }
])

const darkTokens = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
    color: '#e06c75'
  },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#61afef' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#d19a66' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#abb2bf' },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace
    ],
    color: '#e5c07b'
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string)
    ],
    color: '#56b6c2'
  },
  { tag: [tags.meta, tags.comment], color: '#7f848e', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.heading, fontWeight: 'bold', color: '#e06c75' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#d19a66' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#98c379' },
  { tag: tags.invalid, color: '#ffffff', backgroundColor: '#e06c75' }
])

export function editorTheme(dark: boolean): Extension {
  return [
    surface,
    EditorView.darkTheme.of(dark),
    syntaxHighlighting(dark ? darkTokens : lightTokens)
  ]
}

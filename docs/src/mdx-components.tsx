import defaultMdxComponents from 'fumadocs-ui/mdx'
import { Mermaid } from '@/components/mdx/mermaid'
import {
  Callout,
  CommandGroup,
  CommandItem,
  DocCard,
  DocCards,
  Runbook,
  RunbookStep,
  Signal,
  SignalGrid,
  Step,
  Steps
} from '@/components/mdx/docs-components'
import type { MDXComponents } from 'mdx/types'

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Callout,
    CommandGroup,
    CommandItem,
    DocCard,
    DocCards,
    Mermaid,
    Runbook,
    RunbookStep,
    Signal,
    SignalGrid,
    Step,
    Steps,
    ...components
  }
}

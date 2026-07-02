export interface BuiltinSoulTemplate {
  id: string
  name: string
  description: string
  category: string
  tags: readonly string[]
  filename: string
}

export interface BuiltinSoulTemplateWithContent extends BuiltinSoulTemplate {
  content: string
}

export const DEFAULT_BUILTIN_SOUL_TEMPLATE_ID = 'balanced-collaborator'

export const BUILTIN_SOUL_TEMPLATES: readonly BuiltinSoulTemplate[] = [
  {
    id: 'balanced-collaborator',
    name: 'Balanced Professional Collaborator',
    description:
      'A steady default persona for mixed daily work, thoughtful discussion, and general assistance.',
    category: 'general',
    tags: ['daily', 'balanced', 'clear'],
    filename: 'balanced-collaborator.md'
  },
  {
    id: 'senior-engineering-partner',
    name: 'Senior Software Engineering Partner',
    description:
      'A rigorous programming persona for reading code, making scoped changes, debugging, reviews, and technical decisions.',
    category: 'coding',
    tags: ['programming', 'debugging', 'review'],
    filename: 'senior-engineering-partner.md'
  },
  {
    id: 'daily-life-assistant',
    name: 'Daily Life Assistant',
    description:
      'A pragmatic everyday persona for planning, reminders, decisions, messages, travel, learning, and personal organization.',
    category: 'daily',
    tags: ['planning', 'organization', 'everyday'],
    filename: 'daily-life-assistant.md'
  },
  {
    id: 'emotionally-attuned-companion',
    name: 'Emotionally Attuned Companion',
    description:
      'A careful emotional support persona for reflective conversation, relationship wording, and difficult moments.',
    category: 'emotional',
    tags: ['emotional support', 'reflection', 'relationships'],
    filename: 'emotionally-attuned-companion.md'
  },
  {
    id: 'research-writing-strategist',
    name: 'Research and Writing Strategist',
    description:
      'A precise persona for research synthesis, writing plans, editing, argument quality, and source-aware work.',
    category: 'research',
    tags: ['research', 'writing', 'editing'],
    filename: 'research-writing-strategist.md'
  },
  {
    id: 'product-strategy-operator',
    name: 'Product Strategy Operator',
    description:
      'A product and business persona for prioritization, UX tradeoffs, launch planning, and operational clarity.',
    category: 'business',
    tags: ['product', 'strategy', 'operations'],
    filename: 'product-strategy-operator.md'
  }
]

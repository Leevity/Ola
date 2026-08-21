export type ProjectWikiNodeKind = 'file' | 'directory'

export interface ProjectWikiNode {
  path: string
  kind: ProjectWikiNodeKind
  size: number
  modifiedAt: number
  hash?: string
  language?: string
  symbols?: string[]
}

export interface ProjectWikiDocument {
  id: string
  projectRoot: string
  generatedAt: number
  fileCount: number
  nodes: ProjectWikiNode[]
}

export interface ProjectWikiGenerateRequest {
  projectRoot: string
  force?: boolean
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  Crop,
  Expand,
  FolderPlus,
  Image,
  Link2,
  Map as MapIcon,
  Minus,
  Plus,
  Redo2,
  Settings2,
  Type,
  Undo2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import {
  createEmptyDrawGraphProject,
  type DrawGraphNode,
  type DrawGraphProject
} from '../../../../shared/draw-graph'

type Snapshot = Pick<DrawGraphProject, 'nodes' | 'edges'>

export function DrawGraphCanvas(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [project, setProject] = useState(() => createEmptyDrawGraphProject())
  const [selected, setSelected] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const loaded = useRef(false)

  useEffect(() => {
    void ipcClient
      .invoke('draw-graph:list')
      .then((value) => setProjects(value as Array<{ id: string; name: string }>))
    void ipcClient.invoke('draw-graph:load', { id: 'default' }).then((value) => {
      const result = value as { project?: DrawGraphProject }
      if (result.project) setProject(result.project)
      loaded.current = true
    })
  }, [])

  const openProject = (id: string): void => {
    loaded.current = false
    void ipcClient.invoke('draw-graph:load', { id }).then((value) => {
      const result = value as { project: DrawGraphProject }
      setProject(result.project)
      setHistory([])
      setFuture([])
      loaded.current = true
    })
  }

  const createProject = (): void => {
    const id = `canvas-${Date.now()}`
    const next = {
      ...createEmptyDrawGraphProject(id),
      name: `${t('drawPage.graph.project')} ${projects.length + 1}`
    }
    setProject(next)
    setProjects((items) => [...items, { id, name: next.name }])
    loaded.current = true
  }

  useEffect(() => {
    if (!loaded.current) return
    const timer = window.setTimeout(() => void ipcClient.invoke('draw-graph:save', project), 350)
    return () => window.clearTimeout(timer)
  }, [project])

  const commit = (change: (current: DrawGraphProject) => DrawGraphProject): void => {
    setProject((current) => {
      setHistory((items) => [...items.slice(-49), { nodes: current.nodes, edges: current.edges }])
      setFuture([])
      return change(current)
    })
  }

  const addNode = (kind: DrawGraphNode['kind']): void => {
    const node: DrawGraphNode = {
      id: nanoid(),
      kind,
      x: 80 + project.nodes.length * 24,
      y: 80 + project.nodes.length * 20,
      width: 220,
      height: 120,
      title: t(`drawPage.graph.node.${kind}`),
      content: ''
    }
    commit((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelected([node.id])
  }

  const undo = (): void => {
    const previous = history.at(-1)
    if (!previous) return
    setFuture((items) => [{ nodes: project.nodes, edges: project.edges }, ...items])
    setHistory((items) => items.slice(0, -1))
    setProject((current) => ({ ...current, ...previous }))
  }
  const redo = (): void => {
    const next = future[0]
    if (!next) return
    setHistory((items) => [...items, { nodes: project.nodes, edges: project.edges }])
    setFuture((items) => items.slice(1))
    setProject((current) => ({ ...current, ...next }))
  }

  const nodeMap = useMemo(
    () => new Map(project.nodes.map((node) => [node.id, node])),
    [project.nodes]
  )
  const connect = (): void => {
    if (selected.length !== 2) return
    const [source, target] = selected
    if (project.edges.some((edge) => edge.source === source && edge.target === target)) return
    commit((current) => ({
      ...current,
      edges: [...current.edges, { id: nanoid(), source, target }]
    }))
  }
  const applyImageOperation = (type: 'crop' | 'mask' | 'expand' | 'upscale'): void => {
    const nodeId = selected[0]
    if (!nodeId || nodeMap.get(nodeId)?.kind !== 'image') return
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              imageOperations: [
                ...(node.imageOperations ?? []),
                { id: nanoid(), type, value: type === 'upscale' ? 2 : 1 }
              ]
            }
          : node
      )
    }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/10">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={project.id}
          onChange={(event) => openProject(event.target.value)}
        >
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          {!projects.some((item) => item.id === project.id) ? (
            <option value={project.id}>{project.name}</option>
          ) : null}
        </select>
        <Button size="icon" variant="ghost" onClick={createProject}>
          <FolderPlus className="size-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('image')}>
          <Image className="size-4" />
          {t('drawPage.graph.image')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('text')}>
          <Type className="size-4" />
          {t('drawPage.graph.text')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('config')}>
          <Settings2 className="size-4" />
          {t('drawPage.graph.config')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => addNode('text')}>
          {t('drawPage.graph.promptLibrary')}
        </Button>
        <Button size="sm" variant="outline" disabled={selected.length !== 2} onClick={connect}>
          <Link2 className="size-4" />
          {t('drawPage.graph.connect')}
        </Button>
        {nodeMap.get(selected[0])?.kind === 'image' ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => applyImageOperation('crop')}>
              <Crop className="size-4" />
              {t('drawPage.graph.crop')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => applyImageOperation('mask')}>
              {t('drawPage.graph.mask')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => applyImageOperation('expand')}>
              <Expand className="size-4" />
              {t('drawPage.graph.expand')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => applyImageOperation('upscale')}>
              {t('drawPage.graph.upscale')}
            </Button>
          </>
        ) : null}
        <div className="ml-auto flex gap-1">
          <Button size="icon" variant="ghost" disabled={!history.length} onClick={undo}>
            <Undo2 className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" disabled={!future.length} onClick={redo}>
            <Redo2 className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setZoom((value) => Math.max(0.4, value - 0.1))}
          >
            <Minus className="size-4" />
          </Button>
          <span className="min-w-12 self-center text-center text-xs">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setZoom((value) => Math.min(2, value + 0.1))}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
      <div
        className="relative flex-1 overflow-auto"
        onWheel={(event) => {
          if (event.ctrlKey) {
            event.preventDefault()
            setZoom((value) => Math.min(2, Math.max(0.4, value - event.deltaY * 0.001)))
          }
        }}
      >
        <div
          className="relative h-[1200px] w-[1800px] origin-top-left"
          style={{ transform: `scale(${zoom})` }}
        >
          <svg className="pointer-events-none absolute inset-0 size-full">
            {project.edges.map((edge) => {
              const source = nodeMap.get(edge.source)
              const target = nodeMap.get(edge.target)
              if (!source || !target) return null
              return (
                <line
                  key={edge.id}
                  x1={source.x + source.width}
                  y1={source.y + source.height / 2}
                  x2={target.x}
                  y2={target.y + target.height / 2}
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-primary/60"
                />
              )
            })}
          </svg>
          {project.nodes.map((node) => (
            <div
              key={node.id}
              className={cn(
                'absolute rounded-xl border bg-card p-3 shadow-sm',
                selected.includes(node.id) && 'ring-2 ring-primary'
              )}
              style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
              onClick={(event) =>
                setSelected((items) =>
                  event.shiftKey ? Array.from(new Set([...items, node.id])).slice(-2) : [node.id]
                )
              }
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest('textarea,input')) return
                const startX = event.clientX
                const startY = event.clientY
                const originX = node.x
                const originY = node.y
                const move = (next: PointerEvent): void =>
                  setProject((current) => ({
                    ...current,
                    nodes: current.nodes.map((item) =>
                      item.id === node.id
                        ? {
                            ...item,
                            x: originX + (next.clientX - startX) / zoom,
                            y: originY + (next.clientY - startY) / zoom
                          }
                        : item
                    )
                  }))
                const up = (): void => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            >
              <div className="mb-2 text-xs font-semibold">{node.title}</div>
              <textarea
                className="h-16 w-full resize-none rounded-md bg-muted/40 p-2 text-xs outline-none"
                value={node.content}
                placeholder={t(`drawPage.graph.placeholder.${node.kind}`)}
                onChange={(event) =>
                  setProject((current) => ({
                    ...current,
                    nodes: current.nodes.map((item) =>
                      item.id === node.id ? { ...item, content: event.target.value } : item
                    )
                  }))
                }
              />
              {node.kind === 'image' && node.imageOperations?.length ? (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  {node.imageOperations.map((operation) => operation.type).join(' → ')}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="absolute bottom-3 right-3 h-28 w-40 overflow-hidden rounded-lg border bg-background/90 p-2 shadow">
          <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <MapIcon className="size-3" />
            {t('drawPage.graph.minimap')}
          </div>
          <div className="relative h-20 bg-muted/30">
            {project.nodes.map((node) => (
              <span
                key={node.id}
                className="absolute size-2 rounded-sm bg-primary/70"
                style={{
                  left: `${Math.min(94, node.x / 18)}%`,
                  top: `${Math.min(88, node.y / 12)}%`
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 p-2 shadow">
        <div className="text-[10px] font-medium">{t('drawPage.graph.assetLibrary')}</div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {project.nodes.filter((node) => node.kind === 'image').length}{' '}
          {t('drawPage.graph.assets')}
        </div>
      </div>
    </div>
  )
}

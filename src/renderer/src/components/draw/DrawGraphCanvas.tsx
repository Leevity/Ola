import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  Crop,
  Camera,
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
  Video,
  Play,
  Undo2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { generateNativeOpenAIImages } from '@renderer/lib/api/openai-images-provider'
import {
  buildMask,
  cropRaster,
  expandRaster,
  normalizeImageFile,
  rasterSourceToDataUrl,
  upscaleRaster,
  type MaskStroke,
  type RasterAsset
} from '@renderer/lib/draw-image-operations'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useDrawGraphStore } from '@renderer/stores/draw-graph-store'
import {
  createEmptyDrawGraphProject,
  wouldCreateDrawGraphCycle,
  type DrawGraphNode,
  type DrawGraphAssetRef,
  type DrawGraphImageOperation,
  type DrawGraphProject
} from '../../../../shared/draw-graph'
import { resolveReadyDrawGraphTriggers } from '../../../../shared/draw-graph-triggers'
import type {
  MediaRuntimeStatus,
  VideoProviderCapability,
  VideoTask
} from '../../../../shared/media-runtime'
import { AssetLibraryDialog, type AssetLibraryItem } from './graph/AssetLibraryDialog'
import { MaskEditorDialog } from './graph/MaskEditorDialog'
import { PromptLibraryDialog } from './graph/PromptLibraryDialog'
import { AngleGenerationDialog } from './graph/AngleGenerationDialog'

type Snapshot = Pick<DrawGraphProject, 'nodes' | 'edges'>

function toAssetRef(asset: AssetLibraryItem): DrawGraphAssetRef {
  return {
    id: asset.id,
    mediaType: asset.mediaType,
    width: asset.width,
    height: asset.height,
    ...(asset.maskAssetId ? { maskAssetId: asset.maskAssetId } : {})
  }
}

export function DrawGraphCanvas(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const project = useDrawGraphStore((state) => state.project)
  const setProject = useDrawGraphStore((state) => state.setProject)
  const loadProject = useDrawGraphStore((state) => state.loadProject)
  const [selected, setSelected] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [videoCapabilities, setVideoCapabilities] = useState<VideoProviderCapability[]>([])
  const [videoTasks, setVideoTasks] = useState<Map<string, VideoTask>>(new Map())
  const [maskNodeId, setMaskNodeId] = useState<string | null>(null)
  const [maskStrokes, setMaskStrokes] = useState<MaskStroke[]>([])
  const [maskBrushSize, setMaskBrushSize] = useState(48)
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false)
  const [assetLibrary, setAssetLibrary] = useState<AssetLibraryItem[]>([])
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false)
  const [angleNodeId, setAngleNodeId] = useState<string | null>(null)
  const imageOperationControllers = useRef(new Map<string, AbortController>())
  const activeTriggerRuns = useRef(new Set<string>())
  const triggerRunner = useRef<
    | ((
        action: NonNullable<DrawGraphNode['trigger']>['action'],
        node: DrawGraphNode
      ) => Promise<void>)
    | null
  >(null)
  const advancedDrawEnabled = useSettingsStore((state) => state.advancedDrawEnabled)
  const videoGenerationEnabled = useSettingsStore((state) => state.videoGenerationEnabled)
  const loaded = useRef(false)

  useEffect(
    () => () => {
      for (const controller of imageOperationControllers.current.values()) controller.abort()
      imageOperationControllers.current.clear()
    },
    []
  )

  useEffect(() => {
    void ipcClient
      .invoke('draw-graph:list')
      .then((value) => setProjects(value as Array<{ id: string; name: string }>))
    void loadProject('default').then(() => {
      loaded.current = true
    })
  }, [loadProject])

  const refreshVideoTasks = useCallback(async (): Promise<void> => {
    const items = (await ipcClient.invoke('media:tasks-list')) as VideoTask[]
    setVideoTasks(new Map(items.map((task) => [task.id, task])))
  }, [])

  useEffect(() => {
    if (!videoGenerationEnabled) {
      setVideoCapabilities([])
      return
    }
    void ipcClient.invoke('media:status').then((value) => {
      const status = value as MediaRuntimeStatus
      setVideoCapabilities(status.capabilities)
    })
    void refreshVideoTasks()
    const timer = window.setInterval(() => void refreshVideoTasks(), 3000)
    return () => window.clearInterval(timer)
  }, [refreshVideoTasks, videoGenerationEnabled])

  const openProject = (id: string): void => {
    loaded.current = false
    void loadProject(id).then(() => {
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
  const selectedImageBusy = Boolean(
    nodeMap
      .get(selected[0])
      ?.imageOperations?.some((operation) => ['queued', 'running'].includes(operation.state ?? ''))
  )
  const connect = (): void => {
    if (selected.length !== 2) return
    const [source, target] = selected
    if (project.edges.some((edge) => edge.source === source && edge.target === target)) return
    if (wouldCreateDrawGraphCycle(project.edges, source, target)) return
    commit((current) => ({
      ...current,
      edges: [...current.edges, { id: nanoid(), source, target }]
    }))
  }
  const saveAsset = async (dataUrl: string): Promise<DrawGraphAssetRef & { url: string }> =>
    (await ipcClient.invoke('draw-graph:asset-save', { dataUrl })) as AssetLibraryItem

  const refreshAssetLibrary = useCallback(async (): Promise<void> => {
    setAssetLibrary((await ipcClient.invoke('draw-graph:assets-list')) as AssetLibraryItem[])
  }, [])

  const attachImage = async (nodeId: string, file: File): Promise<void> => {
    try {
      const normalized = await normalizeImageFile(file)
      const asset = await saveAsset(normalized.dataUrl)
      void refreshAssetLibrary()
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? { ...node, asset: toAssetRef(asset), status: 'completed', error: undefined }
            : node
        )
      }))
    } catch (error) {
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
              }
            : node
        )
      }))
    }
  }

  const selectLibraryAsset = (asset: AssetLibraryItem): void => {
    const selectedNode = nodeMap.get(selected[0])
    if (selectedNode?.kind === 'image') {
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === selectedNode.id
            ? { ...node, asset: toAssetRef(asset), status: 'completed' }
            : node
        )
      }))
    } else {
      const node: DrawGraphNode = {
        id: nanoid(),
        kind: 'image',
        x: 80 + project.nodes.length * 24,
        y: 80 + project.nodes.length * 20,
        width: 220,
        height: 180,
        title: t('drawPage.graph.node.image'),
        content: '',
        asset: toAssetRef(asset),
        status: 'completed'
      }
      commit((current) => ({ ...current, nodes: [...current.nodes, node] }))
      setSelected([node.id])
    }
    setAssetLibraryOpen(false)
  }

  const usePrompt = ({ title, prompt }: { title: string; prompt: string }): void => {
    const selectedNode = nodeMap.get(selected[0])
    if (selectedNode?.kind === 'text') {
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === selectedNode.id ? { ...node, title, content: prompt } : node
        )
      }))
      return
    }
    const node: DrawGraphNode = {
      id: nanoid(),
      kind: 'text',
      x: 80 + project.nodes.length * 24,
      y: 80 + project.nodes.length * 20,
      width: 260,
      height: 160,
      title,
      content: prompt
    }
    commit((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelected([node.id])
  }

  const setOperationState = (
    nodeId: string,
    operationId: string,
    state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
    patch?: { outputAssetId?: string; error?: string }
  ): void => {
    setProject((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              imageOperations: node.imageOperations?.map((operation) =>
                operation.id === operationId ? { ...operation, state, ...patch } : operation
              )
            }
          : node
      )
    }))
  }

  const applyImageOperation = async (
    type: 'crop' | 'outpaint' | 'upscale',
    retryOperation?: DrawGraphImageOperation,
    requestedNodeId?: string
  ): Promise<void> => {
    const nodeId = requestedNodeId ?? selected[0]
    const sourceNode = nodeMap.get(nodeId)
    if (!nodeId || sourceNode?.kind !== 'image' || !sourceNode.asset) return
    const operationId = retryOperation?.id ?? nanoid()
    const retryParameters = retryOperation?.parameters
    const parameters: Record<string, number> = retryParameters
      ? Object.fromEntries(
          Object.entries(retryParameters).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number'
          )
        )
      : type === 'crop'
        ? {
            x: Math.round(sourceNode.asset.width * 0.1),
            y: Math.round(sourceNode.asset.height * 0.1),
            width: Math.round(sourceNode.asset.width * 0.8),
            height: Math.round(sourceNode.asset.height * 0.8)
          }
        : type === 'outpaint'
          ? {
              left: Math.round(sourceNode.asset.width * 0.2),
              right: Math.round(sourceNode.asset.width * 0.2),
              top: Math.round(sourceNode.asset.height * 0.2),
              bottom: Math.round(sourceNode.asset.height * 0.2)
            }
          : { scale: 2 }
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              imageOperations: [
                ...(retryOperation
                  ? (node.imageOperations ?? []).map((operation) =>
                      operation.id === operationId
                        ? { ...operation, state: 'queued' as const, error: undefined }
                        : operation
                    )
                  : [
                      ...(node.imageOperations ?? []),
                      {
                        id: operationId,
                        type,
                        value: type === 'upscale' ? 2 : 1,
                        parameters,
                        state: 'queued' as const
                      }
                    ])
              ]
            }
          : node
      )
    }))
    setOperationState(nodeId, operationId, 'running')
    const controller = type === 'outpaint' ? new AbortController() : null
    if (controller) imageOperationControllers.current.set(operationId, controller)
    try {
      const source = `ola-draw-asset://${sourceNode.asset.id}`
      let result: RasterAsset & { maskDataUrl?: string } =
        type === 'crop'
          ? await cropRaster(source, {
              x: parameters.x,
              y: parameters.y,
              width: parameters.width,
              height: parameters.height
            })
          : type === 'outpaint'
            ? await expandRaster(source, {
                left: parameters.left,
                right: parameters.right,
                top: parameters.top,
                bottom: parameters.bottom
              })
            : await upscaleRaster(source, 2)
      if (type === 'outpaint') {
        const providerConfig = useProviderStore.getState().getImageProviderConfig()
        if (!providerConfig?.providerId) {
          throw new Error(
            t('drawPage.graph.imageProviderRequired', {
              defaultValue: 'Configure an enabled image generation model first.'
            })
          )
        }
        if (!(await ensureProviderAuthReady(providerConfig.providerId))) {
          throw new Error(
            t('drawPage.graph.imageProviderAuthRequired', {
              defaultValue: 'Image provider authentication is required.'
            })
          )
        }
        const outputs = await generateNativeOpenAIImages({
          config: providerConfig,
          prompt: [
            'Extend this image naturally into the transparent border.',
            'Preserve the original subject, composition, lighting, colors, and visual style.',
            sourceNode.content.trim()
          ]
            .filter(Boolean)
            .join(' '),
          images: [{ dataUrl: result.dataUrl, mediaType: 'image/png' }],
          signal: controller?.signal
        })
        const generated = outputs[0]
        if (!generated) throw new Error('Image provider returned no output')
        result =
          generated.sourceType === 'base64'
            ? {
                dataUrl: `data:${generated.mediaType};base64,${generated.data}`,
                width: result.width,
                height: result.height
              }
            : await rasterSourceToDataUrl(generated.data)
      }
      const outputAsset = await saveAsset(result.dataUrl)
      let maskAssetId: string | undefined
      if (result.maskDataUrl) maskAssetId = (await saveAsset(result.maskDataUrl)).id
      void refreshAssetLibrary()
      const outputNodeId = nanoid()
      const outputNode: DrawGraphNode = {
        ...sourceNode,
        id: outputNodeId,
        x: sourceNode.x + sourceNode.width + 80,
        title: `${sourceNode.title} · ${type}`,
        asset: { ...toAssetRef(outputAsset), ...(maskAssetId ? { maskAssetId } : {}) },
        imageOperations: [],
        status: 'completed',
        error: undefined
      }
      commit((current) => ({
        ...current,
        nodes: [...current.nodes, outputNode],
        edges: [...current.edges, { id: nanoid(), source: sourceNode.id, target: outputNodeId }]
      }))
      setOperationState(nodeId, operationId, 'completed', { outputAssetId: outputAsset.id })
      setSelected([outputNodeId])
    } catch (error) {
      if (controller?.signal.aborted) {
        setOperationState(nodeId, operationId, 'cancelled')
      } else {
        setOperationState(nodeId, operationId, 'failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      imageOperationControllers.current.delete(operationId)
    }
  }

  const beginMaskEdit = (): void => {
    const node = nodeMap.get(selected[0])
    if (node?.kind !== 'image' || !node.asset) return
    setMaskNodeId(node.id)
    setMaskStrokes([])
    setMaskBrushSize(Math.max(8, Math.round(Math.min(node.asset.width, node.asset.height) * 0.05)))
  }

  const generateAngles = async (angles: string[], instructions: string): Promise<void> => {
    const sourceNode = nodeMap.get(angleNodeId ?? '')
    if (!sourceNode?.asset) return
    const setSourceError = (message: string): void =>
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === sourceNode.id ? { ...node, error: message } : node
        )
      }))

    const providerConfig = useProviderStore.getState().getImageProviderConfig()
    if (!providerConfig?.providerId) {
      setSourceError(
        t('drawPage.graph.imageProviderRequired', {
          defaultValue: 'Configure an enabled image generation model first.'
        })
      )
      return
    }
    let source: Awaited<ReturnType<typeof rasterSourceToDataUrl>>
    try {
      if (!(await ensureProviderAuthReady(providerConfig.providerId))) return
      source = await rasterSourceToDataUrl(`ola-draw-asset://${sourceNode.asset.id}`)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
      return
    }
    const operations = angles.map((angle) => ({
      id: nanoid(),
      angle,
      controller: new AbortController()
    }))
    for (const operation of operations) {
      imageOperationControllers.current.set(operation.id, operation.controller)
    }
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === sourceNode.id
          ? {
              ...node,
              error: undefined,
              imageOperations: [
                ...(node.imageOperations ?? []),
                ...operations.map((operation) => ({
                  id: operation.id,
                  type: 'angle' as const,
                  value: 1,
                  parameters: { angle: operation.angle, instructions },
                  state: 'queued' as const
                }))
              ]
            }
          : node
      )
    }))
    setAngleNodeId(null)

    for (const [index, operation] of operations.entries()) {
      if (operation.controller.signal.aborted) continue
      setOperationState(sourceNode.id, operation.id, 'running')
      const prompt = [
        `Render the same subject from a ${operation.angle.replaceAll('-', ' ')} camera angle.`,
        'Preserve identity, materials, colors, proportions, lighting continuity, and background style.',
        instructions
      ]
        .filter(Boolean)
        .join(' ')
      try {
        const outputs = await generateNativeOpenAIImages({
          config: providerConfig,
          prompt,
          images: [{ dataUrl: source.dataUrl, mediaType: 'image/png' }],
          signal: operation.controller.signal
        })
        if (operation.controller.signal.aborted) {
          setOperationState(sourceNode.id, operation.id, 'cancelled')
          continue
        }
        const generated = outputs[0]
        if (!generated) throw new Error('Image provider returned no output')
        const outputDataUrl =
          generated.sourceType === 'base64'
            ? `data:${generated.mediaType};base64,${generated.data}`
            : (await rasterSourceToDataUrl(generated.data)).dataUrl
        const outputAsset = await saveAsset(outputDataUrl)
        const outputNodeId = nanoid()
        const outputNode: DrawGraphNode = {
          ...sourceNode,
          id: outputNodeId,
          x: sourceNode.x + sourceNode.width + 80,
          y: sourceNode.y + index * (sourceNode.height + 32),
          title: `${sourceNode.title} · ${operation.angle}`,
          asset: toAssetRef(outputAsset),
          imageOperations: [],
          status: 'completed',
          error: undefined
        }
        commit((current) => ({
          ...current,
          nodes: [...current.nodes, outputNode],
          edges: [...current.edges, { id: nanoid(), source: sourceNode.id, target: outputNodeId }]
        }))
        setOperationState(sourceNode.id, operation.id, 'completed', {
          outputAssetId: outputAsset.id
        })
        void refreshAssetLibrary()
      } catch (error) {
        if (operation.controller.signal.aborted) {
          setOperationState(sourceNode.id, operation.id, 'cancelled')
        } else {
          setOperationState(sourceNode.id, operation.id, 'failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      } finally {
        imageOperationControllers.current.delete(operation.id)
      }
    }
  }

  const cancelImageOperation = (nodeId: string, operationId: string): void => {
    imageOperationControllers.current.get(operationId)?.abort()
    setOperationState(nodeId, operationId, 'cancelled')
  }

  const saveMaskEdit = async (): Promise<void> => {
    const sourceNode = nodeMap.get(maskNodeId ?? '')
    if (!sourceNode?.asset || maskStrokes.length === 0) return
    const operationId = nanoid()
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === sourceNode.id
          ? {
              ...node,
              imageOperations: [
                ...(node.imageOperations ?? []),
                {
                  id: operationId,
                  type: 'mask',
                  value: maskBrushSize,
                  parameters: { strokeCount: maskStrokes.length, brushSize: maskBrushSize },
                  state: 'running'
                }
              ]
            }
          : node
      )
    }))
    try {
      const mask = buildMask(sourceNode.asset.width, sourceNode.asset.height, maskStrokes)
      const maskAsset = await saveAsset(mask.dataUrl)
      void refreshAssetLibrary()
      const outputNodeId = nanoid()
      const outputNode: DrawGraphNode = {
        ...sourceNode,
        id: outputNodeId,
        x: sourceNode.x + sourceNode.width + 80,
        title: `${sourceNode.title} · mask`,
        asset: { ...sourceNode.asset, maskAssetId: maskAsset.id },
        imageOperations: [],
        status: 'completed',
        error: undefined
      }
      commit((current) => ({
        ...current,
        nodes: [...current.nodes, outputNode],
        edges: [...current.edges, { id: nanoid(), source: sourceNode.id, target: outputNodeId }]
      }))
      setOperationState(sourceNode.id, operationId, 'completed', {
        outputAssetId: sourceNode.asset.id
      })
      setSelected([outputNodeId])
      setMaskNodeId(null)
      setMaskStrokes([])
    } catch (error) {
      setOperationState(sourceNode.id, operationId, 'failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const generateVideo = async (node: DrawGraphNode): Promise<void> => {
    const selectedCapability =
      videoCapabilities.find(
        (item) =>
          item.providerId === node.video?.providerId &&
          item.models.includes(node.video?.model ?? '')
      ) ?? videoCapabilities[0]
    const model = node.video?.model ?? selectedCapability?.models[0]
    if (!selectedCapability || !model || !node.content.trim()) return
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === node.id ? { ...item, status: 'queued', error: undefined } : item
      )
    }))
    try {
      const task = (await ipcClient.invoke('media:task-create', {
        provider: selectedCapability.provider,
        providerId: selectedCapability.providerId,
        model,
        prompt: node.content,
        aspectRatio: node.video?.aspectRatio ?? '16:9',
        durationSeconds: node.video?.durationSeconds ?? 5,
        resolution: node.video?.resolution ?? '720p'
      })) as VideoTask
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id
            ? {
                ...item,
                status: task.state,
                video: {
                  ...item.video,
                  providerId: task.providerId,
                  model: task.model,
                  taskId: task.id
                }
              }
            : item
        )
      }))
      void refreshVideoTasks()
    } catch (error) {
      commit((current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id
            ? {
                ...item,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
              }
            : item
        )
      }))
    }
  }

  const cancelVideo = async (node: DrawGraphNode): Promise<void> => {
    if (!node.video?.taskId) return
    await ipcClient.invoke('media:task-cancel', { id: node.video.taskId })
    await refreshVideoTasks()
  }

  const deleteVideoOutput = async (node: DrawGraphNode): Promise<void> => {
    if (!node.video?.taskId) return
    await ipcClient.invoke('media:task-delete', { id: node.video.taskId })
    commit((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === node.id
          ? {
              ...item,
              status: 'idle',
              error: undefined,
              video: { ...item.video, taskId: undefined, outputUrl: undefined }
            }
          : item
      )
    }))
    await refreshVideoTasks()
  }

  useEffect(() => {
    if (videoTasks.size === 0) return
    setProject((current) => {
      let changed = false
      const nodes = current.nodes.map((node) => {
        if (!node.video?.taskId) return node
        const task = videoTasks.get(node.video.taskId)
        if (!task) return node
        const outputUrl = task.outputUrl ? `ola-media://${task.id}` : undefined
        if (
          node.status === task.state &&
          node.error === task.error &&
          node.video.outputUrl === outputUrl
        )
          return node
        changed = true
        return {
          ...node,
          status: task.state,
          error: task.error,
          video: { ...node.video, outputUrl }
        }
      })
      return changed ? { ...current, nodes } : current
    })
  }, [setProject, videoTasks])

  triggerRunner.current = (action, node) =>
    action === 'generate_video'
      ? generateVideo(node)
      : applyImageOperation(action, undefined, node.id)

  useEffect(() => {
    if (!advancedDrawEnabled) return
    const ready = resolveReadyDrawGraphTriggers(project)
    for (const run of ready) {
      const executionKey = `${project.id}:${run.nodeId}:${run.runKey}`
      if (activeTriggerRuns.current.has(executionKey)) continue
      if (run.action === 'generate_video' && !videoGenerationEnabled) continue
      const node = project.nodes.find((item) => item.id === run.nodeId)
      if (!node) continue
      activeTriggerRuns.current.add(executionKey)
      setProject((current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === run.nodeId && item.trigger
            ? {
                ...item,
                trigger: { ...item.trigger, lastRunKey: run.runKey, lastTriggeredAt: Date.now() }
              }
            : item
        )
      }))
      const operation = triggerRunner.current?.(run.action, node)
      if (!operation) continue
      void operation.finally(() => activeTriggerRuns.current.delete(executionKey))
    }
  }, [advancedDrawEnabled, project, setProject, videoGenerationEnabled])

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
        {videoGenerationEnabled ? (
          <Button size="sm" variant="outline" onClick={() => addNode('video')}>
            <Video className="size-4" />
            {t('drawPage.graph.video')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => addNode('text')}>
          <Type className="size-4" />
          {t('drawPage.graph.text')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('config')}>
          <Settings2 className="size-4" />
          {t('drawPage.graph.config')}
        </Button>
        {advancedDrawEnabled ? (
          <Button size="sm" variant="ghost" onClick={() => setPromptLibraryOpen(true)}>
            {t('drawPage.graph.promptLibrary')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={selected.length !== 2} onClick={connect}>
          <Link2 className="size-4" />
          {t('drawPage.graph.connect')}
        </Button>
        {advancedDrawEnabled && nodeMap.get(selected[0])?.kind === 'image' ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedImageBusy || !nodeMap.get(selected[0])?.asset}
              onClick={() => void applyImageOperation('crop')}
            >
              <Crop className="size-4" />
              {t('drawPage.graph.crop')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedImageBusy || !nodeMap.get(selected[0])?.asset}
              onClick={beginMaskEdit}
            >
              {t('drawPage.graph.mask')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedImageBusy || !nodeMap.get(selected[0])?.asset}
              onClick={() => void applyImageOperation('outpaint')}
            >
              <Expand className="size-4" />
              {t('drawPage.graph.expand')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedImageBusy || !nodeMap.get(selected[0])?.asset}
              onClick={() => void applyImageOperation('upscale')}
            >
              {t('drawPage.graph.upscale')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={selectedImageBusy || !nodeMap.get(selected[0])?.asset}
              onClick={() => setAngleNodeId(selected[0])}
            >
              <Camera className="size-4" />
              {t('drawPage.graph.multiAngle', { defaultValue: 'Angles' })}
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
                if (
                  (event.target as HTMLElement).closest(
                    'textarea,input,button,select,video,canvas,label'
                  )
                )
                  return
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
              {node.kind === 'image' ? (
                <div className="mb-2 space-y-2">
                  {node.asset ? (
                    <img
                      className="max-h-40 w-full rounded-md object-contain bg-black/5"
                      src={`ola-draw-asset://${node.asset.id}`}
                      alt={node.title}
                    />
                  ) : (
                    <label className="flex h-24 cursor-pointer items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                      {t('drawPage.graph.selectAsset', { defaultValue: 'Select image asset' })}
                      <input
                        className="hidden"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          if (file) void attachImage(node.id, file)
                          event.target.value = ''
                        }}
                      />
                    </label>
                  )}
                  {node.asset?.maskAssetId ? (
                    <div className="text-[10px] text-muted-foreground">
                      {t('drawPage.graph.maskAttached', { defaultValue: 'Editable mask attached' })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <textarea
                className="h-16 w-full resize-none rounded-md bg-muted/40 p-2 text-xs outline-none"
                value={node.content}
                disabled={
                  (node.kind === 'video' && !videoGenerationEnabled) ||
                  (node.kind === 'image' && !advancedDrawEnabled && !!node.imageOperations?.length)
                }
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
              {advancedDrawEnabled && ['image', 'video'].includes(node.kind) ? (
                <select
                  className="mt-2 h-7 w-full rounded border bg-background px-1 text-[10px]"
                  value={node.trigger?.enabled ? node.trigger.action : 'off'}
                  onChange={(event) => {
                    const action = event.target.value
                    setProject((current) => ({
                      ...current,
                      nodes: current.nodes.map((item) =>
                        item.id === node.id
                          ? {
                              ...item,
                              trigger:
                                action === 'off'
                                  ? undefined
                                  : {
                                      enabled: true,
                                      action: action as NonNullable<
                                        DrawGraphNode['trigger']
                                      >['action']
                                    }
                            }
                          : item
                      )
                    }))
                  }}
                >
                  <option value="off">{t('drawPage.graph.triggerOff')}</option>
                  {node.kind === 'image' ? (
                    <>
                      <option value="outpaint">{t('drawPage.graph.triggerOutpaint')}</option>
                      <option value="upscale">{t('drawPage.graph.triggerUpscale')}</option>
                    </>
                  ) : (
                    <option value="generate_video">{t('drawPage.graph.triggerVideo')}</option>
                  )}
                </select>
              ) : null}
              {node.kind === 'image' && node.imageOperations?.length ? (
                advancedDrawEnabled ? (
                  <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
                    {node.imageOperations.map((operation) => (
                      <div key={operation.id} className="flex items-center justify-between gap-2">
                        <span>
                          {operation.type}:{operation.state ?? 'idle'}
                        </span>
                        {operation.state === 'failed' &&
                        ['crop', 'outpaint', 'upscale'].includes(operation.type) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void applyImageOperation(
                                operation.type as 'crop' | 'outpaint' | 'upscale',
                                operation
                              )
                            }
                          >
                            {t('drawPage.graph.retry', { defaultValue: 'Retry' })}
                          </Button>
                        ) : null}
                        {['angle', 'outpaint'].includes(operation.type) &&
                        ['queued', 'running'].includes(operation.state ?? '') ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cancelImageOperation(node.id, operation.id)}
                          >
                            {t('drawPage.graph.cancel', { defaultValue: 'Cancel' })}
                          </Button>
                        ) : null}
                        {operation.type === 'angle' && operation.state === 'failed' ? (
                          <Button size="sm" variant="ghost" onClick={() => setAngleNodeId(node.id)}>
                            {t('drawPage.graph.retry', { defaultValue: 'Retry' })}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {t('drawPage.graph.optionalCapabilityDisabled')}
                  </div>
                )
              ) : null}
              {node.kind === 'image' && node.error ? (
                <div className="mt-2 text-[10px] text-destructive">{node.error}</div>
              ) : null}
              {node.kind === 'video' ? (
                <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
                  {videoGenerationEnabled && videoCapabilities.length > 0 ? (
                    <>
                      <select
                        className="h-7 w-full rounded border bg-background px-1"
                        value={`${node.video?.providerId ?? videoCapabilities[0].providerId}:${node.video?.model ?? videoCapabilities[0].models[0]}`}
                        onChange={(event) => {
                          const [providerId, model] = event.target.value.split(':')
                          setProject((current) => ({
                            ...current,
                            nodes: current.nodes.map((item) =>
                              item.id === node.id
                                ? { ...item, video: { ...item.video, providerId, model } }
                                : item
                            )
                          }))
                        }}
                      >
                        {videoCapabilities.flatMap((capability) =>
                          capability.models.map((model) => (
                            <option
                              key={`${capability.providerId}:${model}`}
                              value={`${capability.providerId}:${model}`}
                            >
                              {capability.providerName} · {model}
                            </option>
                          ))
                        )}
                      </select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !node.content.trim() || ['queued', 'running'].includes(node.status ?? '')
                        }
                        onClick={() => void generateVideo(node)}
                      >
                        <Play className="size-3" />
                        {t('drawPage.graph.generate', { defaultValue: 'Generate' })}
                      </Button>
                      {node.video?.taskId && ['queued', 'running'].includes(node.status ?? '') ? (
                        <Button size="sm" variant="ghost" onClick={() => void cancelVideo(node)}>
                          {t('drawPage.graph.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <div>
                      {videoGenerationEnabled
                        ? t('drawPage.graph.videoProviderDisabled')
                        : t('drawPage.graph.optionalCapabilityDisabled')}
                    </div>
                  )}
                  {node.video?.outputUrl ? (
                    <video className="w-full rounded" controls src={node.video.outputUrl} />
                  ) : null}
                  {node.error ? <div className="text-destructive">{node.error}</div> : null}
                  <div>
                    {node.status ?? 'idle'} · {t('drawPage.graph.estimatedCost')}: —
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      !node.video?.taskId || ['queued', 'running'].includes(node.status ?? '')
                    }
                    onClick={() => void deleteVideoOutput(node)}
                  >
                    {t('drawPage.graph.deleteOutput')}
                  </Button>
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
      <button
        type="button"
        className="absolute bottom-3 left-3 rounded-lg border bg-background/90 p-2 text-left shadow"
        onClick={() => {
          void refreshAssetLibrary()
          setAssetLibraryOpen(true)
        }}
      >
        <div className="text-[10px] font-medium">{t('drawPage.graph.assetLibrary')}</div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {assetLibrary.length} {t('drawPage.graph.assets')}
        </div>
      </button>
      <AssetLibraryDialog
        open={assetLibraryOpen}
        assets={assetLibrary}
        onOpenChange={setAssetLibraryOpen}
        onSelect={selectLibraryAsset}
      />
      <MaskEditorDialog
        open={maskNodeId !== null}
        asset={maskNodeId ? (nodeMap.get(maskNodeId)?.asset ?? null) : null}
        strokes={maskStrokes}
        brushSize={maskBrushSize}
        onOpenChange={(open) => {
          if (!open) setMaskNodeId(null)
        }}
        onStrokesChange={setMaskStrokes}
        onBrushSizeChange={setMaskBrushSize}
        onSave={() => void saveMaskEdit()}
      />
      <PromptLibraryDialog
        open={promptLibraryOpen}
        onOpenChange={setPromptLibraryOpen}
        onUsePrompt={usePrompt}
      />
      <AngleGenerationDialog
        open={angleNodeId !== null}
        busy={selectedImageBusy}
        onOpenChange={(open) => {
          if (!open) setAngleNodeId(null)
        }}
        onGenerate={(angles, instructions) => void generateAngles(angles, instructions)}
      />
    </div>
  )
}

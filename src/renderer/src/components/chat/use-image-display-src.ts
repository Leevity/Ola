import { useEffect, useState } from 'react'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export interface ImageDimensions {
  width: number
  height: number
}

const imageDimensionCache = new Map<string, ImageDimensions>()

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isDataUrl(value: string): boolean {
  return value.startsWith('data:')
}

function isFileUrl(value: string): boolean {
  return /^file:\/\//i.test(value)
}

function guessMimeTypeFromPath(value: string): string {
  const pathWithoutQuery = value.split(/[?#]/, 1)[0].toLowerCase()
  if (pathWithoutQuery.endsWith('.jpg') || pathWithoutQuery.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (pathWithoutQuery.endsWith('.webp')) return 'image/webp'
  if (pathWithoutQuery.endsWith('.gif')) return 'image/gif'
  if (pathWithoutQuery.endsWith('.bmp')) return 'image/bmp'
  if (pathWithoutQuery.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

function fileUrlToFilePath(fileUrl: string): string {
  try {
    const parsed = new URL(fileUrl)
    if (parsed.protocol !== 'file:') return ''

    const decodedPath = decodeURIComponent(parsed.pathname)
    if (parsed.hostname) {
      return `//${parsed.hostname}${decodedPath}`
    }
    return decodedPath.replace(/^\/([A-Za-z]:\/)/, '$1')
  } catch {
    return ''
  }
}

export function buildImageDimensionCacheKey(src: string, filePath?: string): string {
  return filePath?.trim() ? `file:${filePath}` : `src:${src}`
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) throw new Error('Invalid data URL')

  const metadata = dataUrl.slice(5, commaIndex)
  const data = dataUrl.slice(commaIndex + 1)
  const mimeType = metadata.split(';')[0] || 'application/octet-stream'

  if (metadata.includes(';base64')) {
    const binary = window.atob(data)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return new Blob([bytes], { type: mimeType })
  }

  return new Blob([decodeURIComponent(data)], { type: mimeType })
}

export function filePathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withLeadingSlash =
    /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
      ? `/${normalized.replace(/^\/+/, '')}`
      : `/${normalized}`
  return encodeURI(`file://${withLeadingSlash}`)
}

export function getCachedImageDimensions(
  src: string,
  filePath?: string,
  displaySrc?: string
): ImageDimensions | null {
  const sourceDimensions = imageDimensionCache.get(buildImageDimensionCacheKey(src, filePath))
  if (sourceDimensions) return sourceDimensions
  return displaySrc ? (imageDimensionCache.get(`display:${displaySrc}`) ?? null) : null
}

export function cacheImageDimensions(
  src: string,
  dimensions: ImageDimensions,
  options?: {
    filePath?: string
    displaySrc?: string
  }
): ImageDimensions {
  imageDimensionCache.set(buildImageDimensionCacheKey(src, options?.filePath), dimensions)
  if (options?.displaySrc) {
    imageDimensionCache.set(`display:${options.displaySrc}`, dimensions)
  }
  return dimensions
}

export function useImageDisplaySrc(src?: string, filePath?: string): string {
  const rawSrc = src ?? ''
  const sourceKey = buildImageDimensionCacheKey(rawSrc, filePath)
  const directSrc = (() => {
    if (rawSrc.startsWith('blob:') || isDataUrl(rawSrc)) return rawSrc
    if (!rawSrc || isHttpUrl(rawSrc)) return ''
    if (isFileUrl(rawSrc)) return ''
    if (!isDataUrl(rawSrc) && !isHttpUrl(rawSrc)) return rawSrc
    return ''
  })()
  const fallbackSrc = isHttpUrl(rawSrc) ? rawSrc : ''
  const [displayState, setDisplayState] = useState<{ key: string; src: string }>({
    key: '',
    src: ''
  })
  const displaySrc = displayState.key === sourceKey ? displayState.src : ''

  useEffect(() => {
    let cancelled = false

    const cleanup = (): void => {
      cancelled = true
    }

    if (rawSrc.startsWith('blob:') || isDataUrl(rawSrc)) {
      return cleanup
    }

    const localPath = filePath?.trim() || (isFileUrl(rawSrc) ? fileUrlToFilePath(rawSrc) : '')
    if (localPath) {
      void ipcClient
        .invoke(IPC.FS_READ_FILE_BINARY, { path: localPath })
        .then((result) => {
          if (cancelled) return
          const readResult = result as { data?: string; error?: string }
          if (!readResult.data) return
          setDisplayState({
            key: sourceKey,
            src: `data:${guessMimeTypeFromPath(localPath)};base64,${readResult.data}`
          })
        })
        .catch(() => undefined)

      return cleanup
    }

    if (!rawSrc) {
      return cleanup
    }

    if (!isHttpUrl(rawSrc)) {
      return cleanup
    }

    void window.api
      .fetchImageBase64({ url: rawSrc })
      .then((result) => {
        if (cancelled) return
        if (result.data) {
          setDisplayState({
            key: sourceKey,
            src: `data:${result.mimeType || 'image/png'};base64,${result.data}`
          })
        }
      })
      .catch(() => undefined)

    return cleanup
  }, [filePath, rawSrc, sourceKey])

  return directSrc || displaySrc || fallbackSrc
}

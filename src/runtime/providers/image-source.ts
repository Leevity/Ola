import type { ModelImage } from '../../shared/runtime/model'
import { readRuntimeImageAsset } from '../storage/runtime-image-assets'

/** Resolves a public model image into a provider-safe URL without accepting paths from a run. */
export function runtimeImageSource(image: ModelImage, workspaceId: string): string {
  if (image.url) return image.url
  if (image.data) return `data:${image.mimeType};base64,${image.data}`
  if (image.assetId)
    return readRuntimeImageAsset({
      workspaceId,
      assetId: image.assetId,
      mimeType: image.mimeType
    })
  throw new Error('INVALID_RUNTIME_IMAGE')
}

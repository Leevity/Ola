export interface RasterAsset {
  dataUrl: string
  width: number
  height: number
}

export interface CropParameters {
  x: number
  y: number
  width: number
  height: number
}

export interface ExpandParameters {
  left: number
  right: number
  top: number
  bottom: number
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function loadRasterImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to load the selected image asset'))
    image.src = source
  })
}

function createCanvas(
  width: number,
  height: number
): {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
} {
  if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384) {
    throw new Error('Image operation output dimensions are unsupported')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas image processing is unavailable')
  return { canvas, context }
}

function output(canvas: HTMLCanvasElement): RasterAsset {
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

export async function normalizeImageFile(file: File): Promise<RasterAsset> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('Select a PNG, JPEG, WebP, or GIF image')
  }
  if (file.size > 20 * 1024 * 1024) throw new Error('Image asset exceeds 20 MB')
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadRasterImage(objectUrl)
    const { canvas, context } = createCanvas(image.naturalWidth, image.naturalHeight)
    context.drawImage(image, 0, 0)
    return output(canvas)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function rasterSourceToDataUrl(source: string): Promise<RasterAsset> {
  const image = await loadRasterImage(source)
  const { canvas, context } = createCanvas(image.naturalWidth, image.naturalHeight)
  context.drawImage(image, 0, 0)
  return output(canvas)
}

export async function cropRaster(source: string, parameters: CropParameters): Promise<RasterAsset> {
  const image = await loadRasterImage(source)
  const x = boundedInteger(parameters.x, 0, image.naturalWidth - 1)
  const y = boundedInteger(parameters.y, 0, image.naturalHeight - 1)
  const width = boundedInteger(parameters.width, 1, image.naturalWidth - x)
  const height = boundedInteger(parameters.height, 1, image.naturalHeight - y)
  const { canvas, context } = createCanvas(width, height)
  context.drawImage(image, x, y, width, height, 0, 0, width, height)
  return output(canvas)
}

export async function upscaleRaster(source: string, scale: number): Promise<RasterAsset> {
  const image = await loadRasterImage(source)
  const safeScale = boundedInteger(scale, 2, 4)
  const width = image.naturalWidth * safeScale
  const height = image.naturalHeight * safeScale
  const { canvas, context } = createCanvas(width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return output(canvas)
}

export async function expandRaster(
  source: string,
  parameters: ExpandParameters
): Promise<RasterAsset & { maskDataUrl: string }> {
  const image = await loadRasterImage(source)
  const left = boundedInteger(parameters.left, 0, 8_192)
  const right = boundedInteger(parameters.right, 0, 8_192)
  const top = boundedInteger(parameters.top, 0, 8_192)
  const bottom = boundedInteger(parameters.bottom, 0, 8_192)
  if (left + right + top + bottom === 0) throw new Error('Expand requires a non-zero border')
  const width = image.naturalWidth + left + right
  const height = image.naturalHeight + top + bottom
  const { canvas, context } = createCanvas(width, height)
  context.clearRect(0, 0, width, height)
  context.drawImage(image, left, top)

  const mask = createCanvas(width, height)
  mask.context.clearRect(0, 0, width, height)
  mask.context.fillStyle = '#fff'
  mask.context.fillRect(left, top, image.naturalWidth, image.naturalHeight)
  return { ...output(canvas), maskDataUrl: mask.canvas.toDataURL('image/png') }
}

export interface MaskStroke {
  size: number
  points: Array<{ x: number; y: number }>
}

export function buildMask(width: number, height: number, strokes: MaskStroke[]): RasterAsset {
  const { canvas, context } = createCanvas(width, height)
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-out'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke.points.length) continue
    context.lineWidth = boundedInteger(stroke.size, 1, Math.max(width, height))
    context.beginPath()
    context.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y)
    if (stroke.points.length === 1) {
      context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2)
      context.fill()
    } else {
      context.stroke()
    }
  }
  context.globalCompositeOperation = 'source-over'
  return output(canvas)
}

import { createRequire } from 'module'

interface GifFrame {
  width: number
  height: number
  bitmap: Buffer
}

interface EncodeGifOptions {
  delayMs: number
  loopCount?: number
}

const require = createRequire(import.meta.url)
const { GifWriter } = require('omggif') as {
  GifWriter: new (
    buffer: Uint8Array,
    width: number,
    height: number,
    options?: { loop?: number }
  ) => {
    addFrame: (
      x: number,
      y: number,
      width: number,
      height: number,
      indexedPixels: Uint8Array,
      options?: { palette: number[]; delay?: number; disposal?: number }
    ) => void
    end: () => number
  }
}

const WEB_SAFE_LEVELS = [0, 51, 102, 153, 204, 255]
const GLOBAL_COLOR_TABLE_SIZE = 256
const TRANSPARENT_INDEX = 255
const TRANSPARENT_ALPHA_THRESHOLD = 16

function buildPalette(): number[] {
  const palette: number[] = []

  for (const red of WEB_SAFE_LEVELS) {
    for (const green of WEB_SAFE_LEVELS) {
      for (const blue of WEB_SAFE_LEVELS) {
        palette.push((red << 16) | (green << 8) | blue)
      }
    }
  }

  for (let index = 0; index < 39; index += 1) {
    const gray = Math.round((index / 38) * 255)
    palette.push((gray << 16) | (gray << 8) | gray)
  }

  palette.push(0x000000)

  while (palette.length < GLOBAL_COLOR_TABLE_SIZE) {
    palette.push(0x000000)
  }

  return palette
}

function clampLevel(value: number): number {
  return Math.max(0, Math.min(5, Math.round(value / 51)))
}

function compositeChannel(channel: number, alpha: number): number {
  if (alpha >= 255) return channel
  const ratio = alpha / 255
  return Math.round(channel * ratio + 255 * (1 - ratio))
}

function quantizeBitmap(bitmap: Buffer): { pixels: Uint8Array; hasTransparency: boolean } {
  const pixels = new Uint8Array(bitmap.length / 4)
  let hasTransparency = false

  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const blue = bitmap[offset]
    const green = bitmap[offset + 1]
    const red = bitmap[offset + 2]
    const alpha = bitmap[offset + 3]

    if (alpha <= TRANSPARENT_ALPHA_THRESHOLD) {
      pixels[offset / 4] = TRANSPARENT_INDEX
      hasTransparency = true
      continue
    }

    const normalizedRed = compositeChannel(red, alpha)
    const normalizedGreen = compositeChannel(green, alpha)
    const normalizedBlue = compositeChannel(blue, alpha)

    const redLevel = clampLevel(normalizedRed)
    const greenLevel = clampLevel(normalizedGreen)
    const blueLevel = clampLevel(normalizedBlue)

    pixels[offset / 4] = redLevel * 36 + greenLevel * 6 + blueLevel
  }

  return { pixels, hasTransparency }
}

export function encodeGif(frames: GifFrame[], options: EncodeGifOptions): Buffer {
  if (frames.length === 0) {
    throw new Error('At least one GIF frame is required.')
  }

  const { width, height } = frames[0]
  if (width <= 0 || height <= 0) {
    throw new Error('GIF frame size is invalid.')
  }

  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error('All GIF frames must share the same dimensions.')
    }
  }

  const palette = buildPalette()
  const buffer = Buffer.alloc(width * height * frames.length * 5 + 8192)
  const writer = new GifWriter(buffer, width, height, {
    loop: Math.max(0, options.loopCount ?? 0)
  })

  for (const frame of frames) {
    const { pixels, hasTransparency } = quantizeBitmap(frame.bitmap)
    writer.addFrame(0, 0, width, height, pixels, {
      palette,
      delay: Math.max(1, Math.round(options.delayMs / 10)),
      disposal: hasTransparency ? 2 : 0,
      ...(hasTransparency ? { transparent: TRANSPARENT_INDEX } : {})
    })
  }

  return Buffer.from(buffer.subarray(0, writer.end()))
}

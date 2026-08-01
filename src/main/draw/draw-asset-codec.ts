export const MAX_DRAW_ASSET_BYTES = 20 * 1024 * 1024

export function parsePngSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export function parseJpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return null
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

export function decodeDrawAssetDataUrl(dataUrl: string): {
  bytes: Buffer
  mediaType: 'image/png' | 'image/jpeg'
  extension: '.png' | '.jpg'
  width: number
  height: number
} {
  const match = /^data:(image\/(?:png|jpeg));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Draw asset must be a PNG or JPEG data URL')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.length > MAX_DRAW_ASSET_BYTES) {
    throw new Error('Draw asset exceeds the size limit')
  }
  const mediaType = match[1] as 'image/png' | 'image/jpeg'
  const size = mediaType === 'image/png' ? parsePngSize(bytes) : parseJpegSize(bytes)
  if (
    !size ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > 16_384 ||
    size.height > 16_384 ||
    size.width * size.height > 100_000_000
  )
    throw new Error('Draw asset dimensions are invalid or unsupported')
  return {
    bytes,
    mediaType,
    extension: mediaType === 'image/png' ? '.png' : '.jpg',
    ...size
  }
}

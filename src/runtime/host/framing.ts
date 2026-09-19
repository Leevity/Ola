import { MAX_RUNTIME_FRAME_BYTES, RuntimeError } from '../../shared/runtime/contracts'

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (!payload.length || payload.length > MAX_RUNTIME_FRAME_BYTES)
    throw new RuntimeError('FRAME_TOO_LARGE')
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length)
  payload.copy(frame, 4)
  return frame
}

export class FrameDecoder {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private payload: Buffer | null = null
  private payloadBytes = 0
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = []
    let offset = 0
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        offset += count
        this.headerBytes += count
        if (this.headerBytes !== 4) continue
        const length = this.header.readUInt32BE()
        if (!length || length > MAX_RUNTIME_FRAME_BYTES)
          throw new RuntimeError('INVALID_FRAME_LENGTH')
        this.payload = Buffer.allocUnsafe(length)
        this.headerBytes = 0
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset)
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count)
      offset += count
      this.payloadBytes += count
      if (this.payloadBytes === this.payload.length) {
        try {
          frames.push(JSON.parse(this.payload.toString('utf8')))
        } catch {
          throw new RuntimeError('INVALID_FRAME_JSON')
        }
        this.payload = null
        this.payloadBytes = 0
      }
    }
    return frames
  }
}

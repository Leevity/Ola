import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'

// Decode the committed RGBA PNGs so an opaque app tile cannot accidentally
// replace the transparent macOS template, even on non-macOS CI runners.
function pixels(png: Buffer): { width: number; height: number; data: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  expect(png[24]).toBe(8)
  expect(png[25]).toBe(6)
  expect(png[28]).toBe(0)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const filtered = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const data = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)]
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4] : 0
      const b = y > 0 ? data[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const prediction =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? Math.floor((a + b) / 2)
              : filter === 4
                ? pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c
                : 0
      data[y * stride + x] = (filtered[y * (stride + 1) + 1 + x] + prediction) & 255
    }
  }
  return { width, height, data }
}

it.each([
  ['trayTemplate.png', 1],
  ['trayTemplate@2x.png', 2]
] as const)('keeps %s as a transparent monochrome ola template', async (name, scale) => {
  const image = pixels(await readFile(`resources/${name}`))
  expect(image.width).toBe(32 * scale)
  expect(image.height).toBe(18 * scale)
  const alpha: number[] = []
  for (let index = 0; index < image.data.length; index += 4) {
    alpha.push(image.data[index + 3])
    if (image.data[index + 3] > 0)
      expect([...image.data.subarray(index, index + 3)]).toEqual([0, 0, 0])
  }
  expect(alpha).toContain(0)
  expect(alpha).toContain(255)
  expect(alpha.filter((value) => value === 0).length).toBeGreaterThan(alpha.length / 3)
})

import { describe, expect, it, vi } from 'vitest'
import { synthesizeSpeechClip, transcribeAudio } from '../../src/main/ipc/pet-handlers'

describe('TS OpenAI-compatible audio routes', () => {
  it('synthesizes speech through the Main TypeScript fetch path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      synthesizeSpeechClip({
        provider: { baseUrl: 'https://audio.example/v1', apiKey: 'secret', model: 'tts-1' },
        input: 'hello',
        voice: 'alloy'
      })
    ).resolves.toEqual({ base64: 'AQID', mediaType: 'audio/mpeg' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://audio.example/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' })
      })
    )
    vi.unstubAllGlobals()
  })

  it('transcribes audio through the Main TypeScript multipart path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      transcribeAudio({
        provider: { baseUrl: 'https://audio.example/v1', apiKey: 'secret', model: 'whisper-1' },
        file: { base64: 'AQID', mediaType: 'audio/webm', fileName: 'voice.webm' }
      })
    ).resolves.toEqual({ text: 'hello world' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://audio.example/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) })
    )
    vi.unstubAllGlobals()
  })
})

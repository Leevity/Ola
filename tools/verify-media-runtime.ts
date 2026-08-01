import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import {
  cancelSeedanceTask,
  createSeedanceTask,
  downloadVideoResult,
  getSeedanceTaskStatus
} from '../src/main/media/seedance-video-adapter'
import type { SharedProviderRecord } from '../src/shared/provider-contract'
import type { VideoGenerationRequest } from '../src/shared/media-runtime'

const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = []
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  request.on('end', () => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8')
    })
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST') response.end(JSON.stringify({ id: 'remote-task-1' }))
    else if (request.method === 'DELETE') response.end('{}')
    else
      response.end(
        JSON.stringify({
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/video.mp4' }
        })
      )
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address === 'object')

const provider: SharedProviderRecord = {
  id: 'provider-1',
  name: 'Video provider',
  type: 'seedance-video',
  apiKey: 'secret-test-key',
  baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
  enabled: true,
  models: [{ id: 'video-model', type: 'seedance-video', enabled: true }]
}
const request: VideoGenerationRequest = {
  provider: 'seedance',
  providerId: provider.id,
  model: 'video-model',
  prompt: 'A paper boat crossing a quiet pond',
  aspectRatio: '16:9',
  durationSeconds: 5,
  resolution: '720p'
}
const context = { provider, request }
const controller = new AbortController()
const remoteTaskId = await createSeedanceTask(context, controller.signal)
assert.equal(remoteTaskId, 'remote-task-1')
const createBody = JSON.parse(requests[0].body) as {
  model: string
  content: Array<{ text?: string }>
}
assert.equal(createBody.model, request.model)
assert.match(createBody.content[0].text ?? '', /--ratio 16:9/)
assert.match(createBody.content[0].text ?? '', /--dur 5/)
assert.equal(requests[0].authorization, 'Bearer secret-test-key')

const status = await getSeedanceTaskStatus(context, remoteTaskId, controller.signal)
assert.equal(status.state, 'completed')
assert.equal(status.outputUrl, 'https://cdn.example/video.mp4')
await cancelSeedanceTask(context, remoteTaskId, controller.signal)
assert.equal(requests.at(-1)?.method, 'DELETE')

await assert.rejects(
  downloadVideoResult('http://127.0.0.1/video.mp4', '/tmp', 'task', controller.signal),
  /HTTPS/
)
server.close()

const runtime = fs.readFileSync('src/main/ipc/media-runtime-handlers.ts', 'utf8')
assert.match(runtime, /resolveMainProviderModel/)
assert.match(runtime, /Unauthorized media IPC sender/)
assert.match(runtime, /remoteTaskId/)
assert.match(runtime, /schedulePoll/)
assert.match(runtime, /downloadVideoResult/)
assert.match(runtime, /Cancel an active video task before deleting it/)
assert.doesNotMatch(runtime, /apiKey\s*:/)

const tool = fs.readFileSync('src/renderer/src/lib/tools/video-generation-tool.ts', 'utf8')
const toolRegistry = fs.readFileSync('src/renderer/src/lib/tools/index.ts', 'utf8')
const taskCard = fs.readFileSync(
  'src/renderer/src/components/chat/VideoGenerationTaskCard.tsx',
  'utf8'
)
const toolCard = fs.readFileSync('src/renderer/src/components/chat/ToolCallCard.tsx', 'utf8')
assert.match(tool, /name: 'GenerateVideo'/)
assert.match(tool, /type: 'video_generation_task'/)
assert.match(tool, /requiresApproval: \(\) => true/)
assert.match(toolRegistry, /updateVideoGenerationToolRegistration/)
assert.match(toolRegistry, /videoGenerationEnabled/)
assert.match(toolRegistry, /unregisterVideoGenerationTool/)
assert.match(taskCard, /media:tasks-list/)
assert.match(taskCard, /media:task-cancel/)
assert.match(taskCard, /ola-media:\/\//)
assert.match(toolCard, /VideoGenerationTaskCard/)

console.log('Media runtime verification passed')

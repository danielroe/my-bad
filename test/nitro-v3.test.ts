import type { ErrorReport } from '../src/types'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('./fixtures/nitro-v3/', import.meta.url)).replace(/\/$/, '')

interface NitroBuilder {
  createNitro: (options: { rootDir: string, dev: boolean, logLevel: number }) => Promise<unknown>
  createDevServer: (nitro: unknown) => { listen: (options: { port: number, hostname: string }) => { url?: string }, close: () => Promise<void> }
  prepare: (nitro: unknown) => Promise<void>
  build: (nitro: unknown) => Promise<void>
}

/** The fixture pins its own toolchain; load it from there rather than from the library's dependencies. */
const { build, createDevServer, createNitro, prepare } = await import(`${root}/toolchain.mjs`) as NitroBuilder

let origin: string
let close: () => Promise<void>

beforeAll(async () => {
  const nitro = await createNitro({ rootDir: root, dev: true, logLevel: 0 })
  const dev = createDevServer(nitro)
  const server = dev.listen({ port: 0, hostname: '127.0.0.1' })
  close = () => dev.close()
  await prepare(nitro)
  await build(nitro)
  origin = server.url!.replace(/\/$/, '')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const res = await fetch(`${origin}/`).catch(() => undefined)
    if (res?.status === 200) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('nitro dev server did not become ready')
}, 120_000)

afterAll(() => close?.())

async function report(path: string): Promise<{ status: number, report: ErrorReport }> {
  const res = await fetch(`${origin}${path}`, {
    headers: {
      'accept': 'application/json',
      'cookie': 'session=secret',
      'authorization': 'Bearer secret',
      'x-request-id': 'abc123',
    },
  })
  return { status: res.status, report: await res.json() as ErrorReport }
}

describe('nitro v3 dev server', () => {
  it('maps the thrown frame to the original source', async () => {
    const { status, report: json } = await report('/boom')
    expect(status).toBe(500)
    expect(json.message).toBe('Exploded while handling boom')
    const app = json.frames.filter(frame => frame.type === 'app')
    expect(app[0]).toMatchObject({ file: './utils/explode.ts', line: 2, column: 9, function: 'explode' })
    expect(app[0]!.compiled!.file).toBe('./node_modules/.nitro/dev/index.mjs')
    expect(app[0]!.snippet!.lines[1]).toContain('throw new Error(`Exploded while handling ')
    expect(app[1]).toMatchObject({ file: './utils/explode.ts', line: 6, function: 'detonate' })
    expect(app[2]).toMatchObject({ file: './routes/boom.ts', line: 5, column: 10 })
    expect(json.causes, 'the HTTPError wrapper repeating the message is merged away').toEqual([])
    expect(json.name).toBe('HTTPError')
    expect(json.status).toBe(500)
  })

  it('maps frames thrown after an await', async () => {
    const { report: json } = await report('/async')
    const app = json.frames.filter(frame => frame.type === 'app')
    expect(app[0]).toMatchObject({ file: './utils/explode.ts', line: 2, column: 9, function: 'explode' })
    expect(app.at(-1)).toMatchObject({ file: './routes/async.ts', line: 6, column: 10 })
  })

  it('carries HTTPError status and data', async () => {
    const { status, report: json } = await report('/http')
    expect(status).toBe(418)
    expect(json.status).toBe(418)
    expect(json.message).toBe('I am a teapot')
    expect(json.frames[0]).toMatchObject({ file: './routes/http.ts', line: 4, type: 'app' })
    expect(json.sections.find(section => section.id === 'data')?.content).toEqual({ brew: 'refused' })
  })

  it('reports the request with redacted headers', async () => {
    const { report: json } = await report('/boom')
    expect(json.sections.find(section => section.id === 'request')?.content).toMatchObject({ method: 'GET', url: '/boom', status: 500 })
    expect(json.sections.find(section => section.id === 'headers')?.content).toMatchObject({
      'cookie': '[redacted]',
      'authorization': '[redacted]',
      'x-request-id': 'abc123',
    })
  })

  it('renders an html page with the channel wired up', async () => {
    const res = await fetch(`${origin}/boom`, { headers: { accept: 'text/html' } })
    const html = await res.text()
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('"channel":"/__my-bad"')
    expect(html).toContain('utils/explode.ts')
  })

  it('streams the current report id over sse', async () => {
    const { report: json } = await report('/boom')
    const res = await fetch(`${origin}/__my-bad/events`, { headers: { accept: 'text/event-stream' } })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('\n\n')) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    const [head, ...rest] = buffer.split('\n\n')[0]!.split('\n')
    expect(head).toBe('event: hello')
    const payload = JSON.parse(rest.join('\n').replace(/^data: /, ''))
    expect(payload.current.id).toBe(json.id)
    expect(payload.history.map((entry: { id: string }) => entry.id)).toContain(json.id)
  })
})

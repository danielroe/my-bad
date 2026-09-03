import type { Server } from 'node:http'
import type { ErrorReport } from '../src'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('./fixtures/nitropack-v2/', import.meta.url)).replace(/\/$/, '')

interface NitropackBuilder {
  createNitro: (options: { rootDir: string, dev: boolean, logLevel: number }) => Promise<{ hooks: { hookOnce: (name: string, fn: () => void) => void }, close: () => Promise<void> }>
  createDevServer: (nitro: unknown) => { app: unknown, close: () => Promise<void> }
  prepare: (nitro: unknown) => Promise<void>
  build: (nitro: unknown) => Promise<void>
}

const { toNodeListener, build, createDevServer, createNitro, prepare } = await import(`${root}/toolchain.mjs`) as NitropackBuilder & { toNodeListener: (app: unknown) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void }

interface DevServer {
  url: string
  close: () => Promise<void>
}

/**
 * Nitro 2 dev mode bundles the app with rollup into `.nitro/dev/index.mjs` and runs it in a
 * worker, so the fixture cannot import `my-bad` from source (the client asset is a virtual
 * module resolved by vitest). The fixture aliases the built output instead.
 */
async function startDevServer(): Promise<DevServer> {
  const nitro = await createNitro({ rootDir: root, dev: true, logLevel: 0 })
  const dev = createDevServer(nitro)
  const http: Server = createServer(toNodeListener(dev.app))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  const reloaded = new Promise<void>(resolve => nitro.hooks.hookOnce('dev:reload', () => resolve()))
  await prepare(nitro)
  await build(nitro)
  await reloaded
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await dev.close()
      await nitro.close()
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}

describe('nitropack v2 with the error handler replaced', () => {
  let server: DevServer
  beforeAll(async () => {
    server = await startDevServer()
  }, 180_000)
  afterAll(() => server?.close())

  async function request(path: string, accept: string): Promise<Response> {
    return fetch(`${server.url}${path}`, { headers: { accept, cookie: 'session=secret' } })
  }

  async function report(path: string): Promise<{ status: number, report: ErrorReport }> {
    const res = await request(path, 'application/json')
    return { status: res.status, report: await res.json() as ErrorReport }
  }

  /**
   * Nitro rewrites stacks to original sources with `loadStackTrace`, but only from inside its
   * own dev error handler. A replacement handler sees raw frames pointing at the rollup bundle,
   * so the default `fsLoader()` maps them through the `.nitro/dev/index.mjs.map` sidecar and
   * `passthroughLoader()` is not needed.
   */
  it('maps worker frames back to the route source', async () => {
    const { status, report: json } = await report('/boom')
    expect(status).toBe(500)
    expect(json).toMatchObject({ name: 'Error', message: 'Widget needs a name', status: 500 })

    const [top, second, third] = json.frames
    expect(top).toMatchObject({ file: `${root}/utils/widget.ts`, line: 3, column: 11, function: 'buildWidget', type: 'app' })
    expect(top!.compiled!.file).toBe(`${root}/.nitro/dev/index.mjs`)
    expect(top!.snippet!.lines[top!.line! - top!.snippet!.start]).toContain('throw new Error(\'Widget needs a name\')')
    expect(second).toMatchObject({ file: `${root}/utils/widget.ts`, line: 9, column: 10, function: 'loadWidget', type: 'app' })
    expect(third).toMatchObject({ file: `${root}/routes/boom.ts`, line: 5, column: 10, type: 'app' })
    expect(json.frames.filter(frame => frame.type === 'internal').length).toBeGreaterThan(0)
  })

  it('maps frames thrown after an await', async () => {
    const { report: json } = await report('/async')
    expect(json.frames[0]).toMatchObject({ file: `${root}/utils/widget.ts`, line: 3, column: 11, type: 'app' })
    expect(json.frames[2]).toMatchObject({ file: `${root}/routes/async.ts`, line: 6, column: 10, type: 'app' })
    expect(json.frames.some(frame => frame.isAsync)).toBe(true)
  })

  it('propagates status, status message and data from createError', async () => {
    const { status, report: json } = await report('/http')
    expect(status).toBe(418)
    expect(json).toMatchObject({ message: 'Teapot', status: 418 })
    expect(json.sections.find(section => section.id === 'data')!.content).toEqual({ hint: 'x' })
    const app = json.frames.find(frame => frame.type === 'app')!
    expect(app).toMatchObject({ file: `${root}/routes/http.ts`, line: 4, column: 9 })
  })

  it('adds a request section with redacted headers', async () => {
    const { report: json } = await report('/boom')
    expect(json.sections.find(section => section.id === 'request')!.content).toMatchObject({ method: 'GET', url: '/boom', status: 500 })
    expect(json.sections.find(section => section.id === 'headers')!.content).toMatchObject({ cookie: '[redacted]', accept: 'application/json' })
  })

  it('renders the throwing line into the html page', async () => {
    const res = await request('/boom', 'text/html')
    const html = await res.text()
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('Widget needs a name')
    expect(html).toContain('utils/widget.ts')
    expect(html).toContain('throw new Error(')
  })
})

describe('nitropack v2 with its own dev error handler', () => {
  let server: DevServer
  beforeAll(async () => {
    process.env.MY_BAD_DEFAULT_HANDLER = '1'
    server = await startDevServer()
  }, 180_000)
  afterAll(async () => {
    delete process.env.MY_BAD_DEFAULT_HANDLER
    await server?.close()
  })

  it('still renders its own error page', async () => {
    const res = await fetch(`${server.url}/boom`, { headers: { accept: 'application/json' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ statusCode: 500, message: 'Widget needs a name' })
  })
})

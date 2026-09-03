import type { ViteDevServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { myBad, useMyBad, viteLoader } from '../src/vite'

const root = fileURLToPath(new URL('./fixtures/vite-ssr/', import.meta.url)).replace(/\/$/, '')

let server: ViteDevServer
beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    plugins: [myBad({ channel: { history: 5 } })],
  })
})
afterAll(() => server.close())

async function thrown(): Promise<Error> {
  const mod = await server.ssrLoadModule('/src/entry.ts')
  try {
    mod.render([])
  }
  catch (error) {
    return error as Error
  }
  throw new Error('expected throw')
}

describe('vite', () => {
  it('maps ssrLoadModule frames through the module graph', async () => {
    const ctx = useMyBad(server)!
    const report = await ctx.report(await thrown())
    expect(report.frames[0]).toMatchObject({ file: `${root}/src/lib.ts`, line: 2, column: 17, function: 'explode', type: 'app' })
    expect(report.frames[0]!.compiled).toMatchObject({ file: `${root}/src/lib.ts`, line: 6 })
    expect(report.frames[0]!.snippet!.lines[1]).toContain('new Error(`Render failed')
    expect(report.frames[1]).toMatchObject({ file: `${root}/src/entry.ts`, line: 10, function: 'Module.render' })
  })

  it('does not double-map frames that are already original', async () => {
    await thrown()
    const loader = viteLoader(server)
    const mapped = await loader.map!({ file: `${root}/src/lib.ts`, line: 2, column: 17, type: 'app' })
    expect(mapped).toBeUndefined()
  })

  it('serves the channel through middlewares and emits errors', async () => {
    const ctx = useMyBad(server)!
    const report = await ctx.emit(await thrown())
    expect(ctx.channel.current?.id).toBe(report.id)
    const http = createHttpServer(server.middlewares)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as { port: number }
    const res = await fetch(`http://127.0.0.1:${port}/__my-bad/history/${report.id}`)
    const body = await res.text()
    http.close()
    expect(res.status).toBe(200)
    expect(JSON.parse(body).id).toBe(report.id)
    const page = ctx.page(report)
    expect(page).toContain('"channel":"/__my-bad"')
    ctx.clear()
    expect(ctx.channel.current).toBeUndefined()
  })

  it('renders compile errors from hmr error payloads', async () => {
    const ctx = useMyBad(server)!
    const report = await ctx.report({
      message: 'Unexpected token',
      plugin: 'vite:esbuild',
      id: `${root}/src/entry.ts`,
      loc: { file: `${root}/src/entry.ts`, line: 8, column: 3 },
      frame: '',
    }, { kind: 'compile' })
    expect(report.kind).toBe('compile')
    expect(report.frames[0]).toMatchObject({ line: 8, type: 'app' })
    expect(report.frames[0]!.snippet!.lines).toContain('  const first = items[0]')
  })
})

describe('hmr replay', () => {
  it('replays the latest overlay to clients that connect after the error', async () => {
    const ctx = useMyBad(server)!
    const sent: unknown[] = []
    const hot = (server as unknown as { environments: Record<string, { hot: { on: (e: string, fn: () => void) => void, send: (p: unknown) => void } }> }).environments.client!.hot
    const original = hot.send
    hot.send = (payload: unknown) => sent.push(payload)
    try {
      await ctx.emit(await thrown())
      expect(sent.filter(p => (p as { event?: string }).event === 'my-bad:error')).toHaveLength(1)
      const listeners = (hot as unknown as { listeners?: Map<string, Set<() => void>> }).listeners
      const connectionHandlers = listeners?.get('connection')
      if (connectionHandlers) {
        for (const handler of connectionHandlers) {
          handler()
        }
        expect(sent.filter(p => (p as { event?: string }).event === 'my-bad:error').length).toBeGreaterThan(1)
      }
      ctx.clear()
    }
    finally {
      hot.send = original
    }
  })
})

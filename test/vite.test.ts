import type { DevToolsPluginOptions } from '@vitejs/devtools-kit'
import type { Plugin, ViteDevServer } from 'vite'
import type { MyBadDevToolsOptions } from '../src/vite'
import type { DevToolsPlugin } from '../src/vite/devtools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { myBad, myBadDevTools, useMyBad, viteLoader } from '../src/vite'

const root = fileURLToPath(new URL('./fixtures/vite-ssr/', import.meta.url)).replace(/\/$/, '')

let server: ViteDevServer
beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    plugins: [
      myBad({
        channel: { history: 5 },
      }),
    ],
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
    expect(report.frames[0]).toMatchObject({
      file: `${root}/src/lib.ts`,
      line: 2,
      column: 17,
      function: 'explode',
      type: 'app',
    })
    expect(report.frames[0]!.compiled).toMatchObject({ file: `${root}/src/lib.ts`, line: 6 })
    expect(report.frames[0]!.snippet!.lines[1]).toContain('new Error(`Render failed')
    expect(report.frames[1]).toMatchObject({ file: `${root}/src/entry.ts`, line: 10, function: 'Module.render' })
  })

  it('does not double-map frames that are already original', async () => {
    await thrown()
    const loader = viteLoader(server)
    const mapped = await loader.map!({
      file: `${root}/src/lib.ts`,
      line: 2,
      column: 17,
      type: 'app',
    })
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

describe('client assets', () => {
  it('serves the client script and stylesheet instead of inlining them', async () => {
    const ctx = useMyBad(server)!
    const report = await ctx.report(await thrown())
    const page = ctx.page(report)
    expect(page.slice(0, page.indexOf('</head>'))).toMatch(/<link rel="stylesheet" href="\/__my-bad\/client\.css\?v=\w+">/)
    expect(page.slice(0, page.indexOf('</head>'))).not.toContain('--mb-accent')
    expect(page).toMatch(/<script src="\/__my-bad\/client\.js\?v=\w+"><\/script>/)
    expect(ctx.overlay(report)).toContain('"stylesUrl":"/__my-bad/client.css?v=')

    const http = createHttpServer(server.middlewares)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as { port: number }
    const [script, styles] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/__my-bad/client.js?v=1`),
      fetch(`http://127.0.0.1:${port}/__my-bad/client.css`),
    ])
    const [scriptBody, stylesBody] = await Promise.all([
      script.text(),
      styles.text(),
    ])
    http.close()
    expect(script.headers.get('content-type')).toContain('text/javascript')
    expect(styles.headers.get('content-type')).toContain('text/css')
    expect(styles.headers.get('cache-control')).toContain('immutable')
    expect(scriptBody).toContain('mb-overlay')
    expect(stylesBody).toContain('--mb-accent')
  })

  it('stamps pages, overlays and the docked page with `html.cspNonce`', async () => {
    const secured = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      html: { cspNonce: 'vite-nonce' },
      server: { middlewareMode: true, hmr: false },
      plugins: [
        myBad(),
      ],
    })
    const http = createHttpServer(secured.middlewares)
    try {
      const ctx = useMyBad(secured)!
      const report = await ctx.report(new Error('secured'))
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
      const { port } = http.address() as { port: number }
      const panel = await fetch(`http://127.0.0.1:${port}/__my-bad/panel`).then(res => res.text())
      for (const html of [
        ctx.page(report),
        ctx.overlay(report),
        panel,
      ]) {
        const tags = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script[^>]*>/gi, '$1').match(/<(?:script|style|link)\b[^>]*>/gi)!
        expect(tags.length).toBeGreaterThan(1)
        expect(tags.filter(tag => !tag.includes(' nonce="vite-nonce"'))).toEqual([])
      }
      expect(ctx.page(report, { nonce: 'own' })).toContain('<style nonce="own">')
    }
    finally {
      http.close()
      await secured.close()
    }
  })

  it('inlines the client when asked', async () => {
    const inlined = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      plugins: [
        myBad({ inlineClient: true }),
      ],
    })
    try {
      const ctx = useMyBad(inlined)!
      const page = ctx.page(await ctx.report(new Error('inline')))
      expect(page.slice(0, page.indexOf('</head>'))).toContain('--mb-accent')
      expect(page).not.toContain('<script src=')
    }
    finally {
      await inlined.close()
    }
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

describe('devtools', () => {
  function setup(plugin: Plugin) {
    const docks: unknown[] = []
    ;(plugin as DevToolsPlugin).devtools?.setup({
      docks: {
        register: entry => docks.push(entry),
      },
    })
    return docks
  }

  it('accepts the Vite DevTools setup context', () => {
    expectTypeOf<NonNullable<DevToolsPlugin['devtools']>>().toExtend<DevToolsPluginOptions>()
  })

  it('registers a dock that the badge opens, with its script served by the plugin', async () => {
    const plugin = myBad({
      base: '/__bad',
      overlay: {
        theme: { name: 'Bad' },
      },
    })
    const docked = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      plugins: [plugin],
    })
    const http = createHttpServer(docked.middlewares)
    try {
      const load = (plugin.load as (id: string) => Promise<string>).bind({})
      expect(await load('\0virtual:my-bad/client')).toMatch(/installMyBadClient\(import\.meta\.hot\)\n$/)
      expect(setup(plugin)).toEqual([
        {
          id: 'my-bad',
          type: 'iframe',
          title: 'Problems',
          icon: 'ph:bug-beetle-duotone',
          url: '/__bad/panel?embed',
          clientScript: { importFrom: '/__bad/dock.js', eager: true },
        },
      ])
      expect(await load('\0virtual:my-bad/client')).toContain('installMyBadClient(import.meta.hot, { awaitHost: 3000 })')
      const events = await useMyBad(docked)!.channel.fetchHandler(new Request('http://localhost/__bad/events'), { trusted: true })
      const reader = events!.body!.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      expect(new TextDecoder().decode(value)).toContain('"devtools":true')

      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
      const { port } = http.address() as { port: number }
      const [dock, panel] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/__bad/dock.js`).then(res => res.text()),
        fetch(`http://127.0.0.1:${port}/__bad/panel?embed`).then(res => res.text()),
      ])
      expect(dock).toMatch(/^import setup from "\/__bad\/devtools\.js\?v=\w+"\n/)
      const badge = JSON.parse(dock.match(/^const badge = (.*)$/m)![1]!)
      expect(badge.src).toMatch(/^\/__bad\/badge\.js\?v=\w+$/)
      expect(badge.state.overlay).toMatchObject({
        channel: '/__bad',
        cwd: root,
        theme: { name: 'Bad' },
      })
      expect(panel).toContain('{"mode":"docked","channel":"/__bad","embed":true')
      const rebound = await new Promise<number>((resolve, reject) => {
        httpGet({
          host: '127.0.0.1',
          port,
          path: '/__bad/dock.js',
          headers: { host: `evil.example:${port}` },
        }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        }).on('error', reject)
      })
      expect(rebound).toBe(403)
    }
    finally {
      http.close()
      await docked.close()
    }
  })

  it('tells its channel about a dock registered before the server is configured', async () => {
    const plugin = myBad({ base: '/__bad' })
    setup(plugin)
    const docked = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      plugins: [plugin],
    })
    try {
      const events = await useMyBad(docked)!.channel.fetchHandler(new Request('http://localhost/__bad/events'), { trusted: true })
      const reader = events!.body!.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      expect(new TextDecoder().decode(value)).toContain('"devtools":true')
    }
    finally {
      await docked.close()
    }
  })

  it('registers no dock when asked not to, or without the channel', () => {
    expect(setup(myBad({ devtools: false }))).toEqual([])
    expect(setup(myBad({ channel: false }))).toEqual([])
  })

  it('reports the dock it registers for a channel served elsewhere', () => {
    let registered = 0
    const plugin = myBadDevTools({
      channel: '/__my-bad',
      onRegister: () => registered++,
    })
    expect(registered).toBe(0)
    setup(plugin)
    expect(registered).toBe(1)
  })

  it('ignores an undeclared clientScript for a channel served elsewhere', () => {
    const [dock] = setup(myBadDevTools({ channel: '/__my-bad', clientScript: '/elsewhere.js' } as MyBadDevToolsOptions))
    expect(dock).toMatchObject({
      clientScript: {
        importFrom: expect.stringMatching(/^\/__my-bad\/devtools\.js\?v=\w+$/),
      },
    })
  })

  it('registers a dock for a channel served elsewhere', () => {
    expect(setup(myBadDevTools({ channel: '/__nuxt_error', title: 'Nuxt errors' }))).toEqual([
      {
        id: 'my-bad',
        type: 'iframe',
        title: 'Nuxt errors',
        icon: 'ph:bug-beetle-duotone',
        url: '/__nuxt_error/panel?embed&title=Nuxt%20errors',
        clientScript: {
          importFrom: expect.stringMatching(/^\/__nuxt_error\/devtools\.js\?v=\w+$/),
          eager: true,
        },
      },
    ])
  })
})

describe('source reads', () => {
  it('only reads sources that vite would serve', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'my-bad-vite-'))
    const denied = `${root}/src/private.ts`
    await writeFile(join(outside, 'secret.ts'), 'export const token = 1\n')
    await writeFile(denied, 'export const token = 1\n')
    const guarded = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: {
        middlewareMode: true,
        hmr: false,
        fs: {
          deny: ['private.ts'],
        },
      },
      plugins: [
        myBad({ channel: false }),
      ],
    })
    try {
      const error = new Error('boom')
      error.stack = `Error: boom\n    at a (${outside.replaceAll('\\', '/')}/secret.ts:1:1)\n    at b (${denied}:1:1)\n    at c (${root}/src/lib.ts:2:1)`
      const report = await useMyBad(guarded)!.report(error)
      expect(report.frames.map(frame => !!frame.snippet)).toEqual([false, false, true])
    }
    finally {
      await guarded.close()
      await rm(outside, { recursive: true, force: true })
      await rm(denied, { force: true })
    }
  })
})

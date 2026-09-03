import { describe, expect, it } from 'vitest'
import { createReport } from '../src'
import { envPreset, nuxtPreset, parseVueTrace, requestPreset, traceFromInstance, vuePreset } from '../src/presets'

const base = { loaders: [], snippets: false }

describe('presets', () => {
  it('env adds a collapsed environment section', async () => {
    const report = await createReport(new Error('x'), { ...base, presets: [envPreset({ versions: { nuxt: '4.0.0', vite: undefined } })] })
    const env = report.sections.find(section => section.id === 'env')!
    expect(env.collapsed).toBe(true)
    expect(env.content).toMatchObject({ 'nuxt': '4.0.0', 'my-bad': expect.any(String) })
    expect(env.content).not.toHaveProperty('vite')
    expect((env.content as any).runtime).toMatch(/^node \d/)
  })

  it('vue parses warn traces and instances', async () => {
    expect(parseVueTrace(' at <Child key=0 > \n at <App>')).toEqual([{ label: '<App>' }, { label: '<Child>' }])
    const app = { type: { __name: 'App', __file: '/proj/app.vue' }, parent: null }
    const page = { type: { __file: '/proj/pages/index.vue' }, parent: app }
    expect(traceFromInstance(page)).toEqual([{ label: '<App>', file: '/proj/app.vue' }, { label: '<index>', file: '/proj/pages/index.vue' }])

    const report = await createReport(new Error('x'), { ...base, presets: [vuePreset()], context: { instance: page } })
    expect(report.trace).toHaveLength(2)
    const proxy = { $: page }
    expect(traceFromInstance(proxy)).toEqual(traceFromInstance(page))
    const fromString = await createReport(new Error('x'), { ...base, presets: [vuePreset()], context: { trace: ' at <App>' } })
    expect(fromString.trace).toEqual([{ label: '<App>' }])
  })

  it('vue marks runtime frames internal', async () => {
    const error = new Error('x')
    error.stack = 'Error: x\n    at renderComponentRoot (/proj/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:1:1)\n    at setup (/proj/app.vue:2:2)'
    const report = await createReport(error, { ...base, presets: [vuePreset()] })
    expect(report.frames.map(frame => frame.type)).toEqual(['internal', 'app'])
  })

  it('request redacts sensitive headers from h3 v2 style events', async () => {
    const event = { req: { method: 'POST', url: 'http://localhost:3000/api/x?y=1', headers: new Headers({ cookie: 'secret', accept: 'text/html' }) } }
    const report = await createReport(new Error('x'), { ...base, presets: [requestPreset()], context: { event } })
    expect(report.sections[0]).toEqual({ id: 'request', title: 'Request', content: { method: 'POST', url: '/api/x?y=1' } })
    expect(report.sections[1]).toMatchObject({ id: 'headers', collapsed: true, content: { cookie: '[redacted]', accept: 'text/html' } })
  })

  it('request handles node requests and h3 v1 events', async () => {
    const req = { method: 'GET', url: '/a', headers: { authorization: 'Bearer x', host: 'h' } }
    const v1 = await createReport(new Error('x'), { ...base, presets: [requestPreset()], context: { event: { node: { req } } } })
    expect(v1.sections[1]!.content).toEqual({ authorization: '[redacted]', host: 'h' })
    const direct = await createReport(new Error('x'), { ...base, presets: [requestPreset({ headers: false })], context: { req } })
    expect(direct.sections).toHaveLength(1)
  })

  it('nuxt links codes to docs, adds route and collapses internals', async () => {
    const error = Object.assign(new Error('x', { cause: Object.assign(new Error('inner'), { code: 'E2001' }) }), { code: 'E1001' })
    error.stack = `Error: x
    at callWithNuxt (/proj/node_modules/nuxt/dist/app/nuxt.js:1:1)
    at setup (/proj/pages/index.vue:2:2)
    at fn (/proj/.nuxt/dev/index.mjs:3:3)`
    const report = await createReport(error, {
      ...base,
      presets: [nuxtPreset({ versions: { nuxt: '4.1.0' } })],
      context: { route: { fullPath: '/x?y', name: 'x', matched: [{ name: 'x' }], meta: { layout: 'default', middleware: ['auth'] } } },
    })
    expect(report.docsUrl).toBe('https://nuxt.com/docs/errors/e1001')
    expect(report.causes[0]!.docsUrl).toBe('https://nuxt.com/docs/errors/e2001')
    expect(report.frames.map(frame => frame.type)).toEqual(['internal', 'app', 'internal'])
    expect(report.sections.map(section => section.id)).toEqual(['route', 'env'])
    expect(report.sections[0]!.content).toEqual({ path: '/x?y', name: 'x', matched: 'x', layout: 'default', middleware: 'auth' })
  })
})

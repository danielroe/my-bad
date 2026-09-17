import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi, renderOverlay, renderPage, serializeReport, toMarkdown } from '../src'
import { escapeHtml } from '../src/render/html/escape'
import { highlightLine } from '../src/render/html/highlight'
import { stripAnsi } from '../src/report/ansi'
import { relativeToCwd, resolvePath, stripCacheQuery, toPath } from '../src/report/path'
import { parseCodeFrame } from '../src/report/snippet'

const stackLine = fc.oneof(
  fc.tuple(fc.string(), fc.string(), fc.nat(), fc.nat()).map(([fn, file, line, col]) => `    at ${fn} (${file}:${line}:${col})`),
  fc.tuple(fc.string(), fc.nat(), fc.nat()).map(([file, line, col]) => `    at ${file}:${line}:${col}`),
  fc.string().map(text => `    at ${text}`),
  fc.string(),
)

const errorLike = fc.record({
  name: fc.option(fc.string(), { nil: undefined }),
  message: fc.string(),
  stack: fc.option(fc.array(stackLine, { maxLength: 12 }).map(lines => lines.join('\n')), { nil: undefined }),
  code: fc.option(fc.oneof(fc.string(), fc.nat()), { nil: undefined }),
  statusCode: fc.option(fc.oneof(fc.nat(), fc.string()), { nil: undefined }),
  data: fc.option(fc.jsonValue(), { nil: undefined }),
}, { requiredKeys: ['message'] })

const compileLike = fc.record({
  message: fc.string(),
  plugin: fc.option(fc.string(), { nil: undefined }),
  id: fc.option(fc.string(), { nil: undefined }),
  loc: fc.option(fc.record({ file: fc.option(fc.string(), { nil: undefined }), line: fc.integer({ min: -5, max: 5000 }), column: fc.integer({ min: -5, max: 500 }) }), { nil: undefined }),
  frame: fc.option(fc.string(), { nil: undefined }),
})

const anyInput = fc.oneof(
  errorLike,
  compileLike,
  fc.string(),
  fc.jsonValue(),
  fc.constant(undefined),
  fc.constant(null),
  errorLike.map((base) => {
    const error = new Error(base.message)
    Object.assign(error, base)
    return error
  }),
)

const options = { loaders: [], snippets: false }

describe('fuzz', () => {
  it('createReport never throws and always serialises', async () => {
    await fc.assert(fc.asyncProperty(anyInput, async (input) => {
      const report = await createReport(input, options)
      expect(typeof report.id).toBe('string')
      expect(typeof report.message).toBe('string')
      expect(Array.isArray(report.frames)).toBe(true)
      const json = JSON.stringify(serializeReport(report, { cwd: '/proj' }))
      expect(JSON.parse(json).id).toBe(report.id)
    }), { numRuns: 300 })
  })

  it('renderers never throw and html escapes report text', async () => {
    await fc.assert(fc.asyncProperty(errorLike, fc.option(fc.string(), { nil: undefined }), async (input, hint) => {
      const report = await createReport(input, options)
      report.hint = hint
      const page = renderPage(report, { cwd: '/proj', channel: '/__my-bad' })
      const overlay = renderOverlay(report)
      const markup = page.slice(0, page.indexOf('<script type="application/json">'))
      for (const text of [report.message, report.name, hint ?? '']) {
        expect(markup).toContain(escapeHtml(text))
      }
      expect(markup).not.toMatch(/<(?![a-z!/])/i)
      expect(overlay).not.toMatch(/<\/script><script>/i)
      const ansi = renderAnsi(report, { colors: true, width: 60 })
      expect(typeof stripAnsi(ansi)).toBe('string')
      expect(typeof toMarkdown(report)).toBe('string')
    }), { numRuns: 200 })
  })

  it('escaping and highlighting never emit unescaped angle brackets from input', () => {
    fc.assert(fc.property(fc.string(), fc.constantFrom('ts', 'js', 'vue', 'html', 'css', 'json', undefined), (code, lang) => {
      const out = highlightLine({ start: 1, lines: [code], lang }, 0)
      const stripped = out.replace(/<\/?span[^>]*>/g, '')
      expect(stripped).not.toMatch(/[<>]/)
      expect(escapeHtml(code)).not.toMatch(/[<>"']/)
    }), { numRuns: 500 })
  })

  it('path helpers are total', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      expect(typeof toPath(a)).toBe('string')
      expect(typeof stripCacheQuery(a)).toBe('string')
      expect(typeof relativeToCwd(a, b)).toBe('string')
      expect(typeof resolvePath(a, b)).toBe('string')
    }), { numRuns: 500 })
    fc.assert(fc.property(fc.string(), (frame) => {
      const parsed = parseCodeFrame(frame)
      if (parsed) {
        expect(parsed.start).toBeGreaterThanOrEqual(0)
        expect(parsed.lines.length).toBeGreaterThan(0)
      }
    }), { numRuns: 300 })
  })
})

describe('embedded state', () => {
  it('round-trips arbitrary report text through the page', async () => {
    await fc.assert(fc.asyncProperty(fc.string(), fc.string(), async (message, code) => {
      const report = await createReport(new Error(message), options)
      report.frames = [{ file: '/proj/a.ts', line: 1, column: 1, type: 'app', snippet: { start: 1, lines: [code], lang: 'vue' } }]
      const html = renderPage(report)
      const open = '<script type="application/json">'
      const start = html.indexOf(open) + open.length
      const state = html.slice(start, html.indexOf('</script>', start))
      expect(state).not.toMatch(/<(?:\/script|!--)/i)
      const parsed = JSON.parse(state)
      expect(parsed.report.message).toBe(message)
      expect(parsed.report.frames[0].snippet.lines[0]).toBe(code)
    }), { numRuns: 300 })
  })
})

function poison<T>(value: T, payload: string): T {
  if (typeof value === 'string' || typeof value === 'number') {
    return payload as T
  }
  if (Array.isArray(value)) {
    return value.map(item => poison(item, payload)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poison(item, payload)])) as T
  }
  return value
}

interface Shape { message: string, causes: number, errors: number, frames: number, compiled: boolean, trace: boolean, section: boolean, history: boolean, status: boolean }

describe('escaping', () => {
  const shape = fc.record({
    message: fc.string(),
    causes: fc.nat({ max: 2 }),
    errors: fc.nat({ max: 2 }),
    frames: fc.nat({ max: 3 }),
    compiled: fc.boolean(),
    trace: fc.boolean(),
    section: fc.boolean(),
    history: fc.boolean(),
    status: fc.boolean(),
  })

  async function poisoned(spec: Shape, payload: string) {
    const base = await createReport(new Error(spec.message), options)
    base.frames = Array.from({ length: spec.frames }, (_, index) => ({
      type: (['app', 'vendor', 'internal'] as const)[index % 3]!,
      file: `/proj/f${index}.ts`,
      function: `fn${index}`,
      line: 1,
      column: 1,
      snippet: { start: 1, lines: ['const a = 1'], lang: 'ts' },
      compiled: spec.compiled ? { file: `/proj/f${index}.js`, line: 2, column: 3, snippet: { start: 2, lines: ['var a = 1'] } } : undefined,
    }))
    base.hint = 'hint'
    base.code = 'E1'
    base.docsUrl = 'https://example.com'
    base.status = spec.status ? 500 : undefined
    base.trace = spec.trace ? [{ label: '<App>', file: '/proj/app.vue', line: 1 }] : undefined
    base.sections = spec.section ? [{ id: 'request', title: 'Request', content: { method: 'GET' } }] : []
    base.causes = Array.from({ length: spec.causes }, (_, index) => ({ ...base, id: `c${index}`, causes: [], errors: undefined }))
    base.errors = spec.errors ? Array.from({ length: spec.errors }, (_, index) => ({ ...base, id: `e${index}`, causes: [], errors: undefined })) : undefined
    const history = spec.history ? [{ id: base.id, kind: 'error' as const, name: 'a', message: 'b', timestamp: 0 }, { id: 'other', kind: 'error' as const, name: 'c', message: 'd', timestamp: 1 }] : undefined
    const report = poison(base, payload)
    return renderPage(report, { cwd: '/proj', channel: '/__my-bad', environment: payload, history: poison(history, payload), theme: { name: payload, url: payload, scheme: payload as 'dark' } })
  }

  it('escapes every field it renders, whatever the report looks like', async () => {
    const breakout = fc.constantFrom('"><mb-canary>', '\'><mb-canary>', '</script><mb-canary>', '<mb-canary onx=1>', '" onx="1', '&<>"\'')
    await fc.assert(fc.asyncProperty(shape, breakout, async (spec, payload) => {
      const html = await poisoned(spec, payload)
      const markup = html.slice(0, html.indexOf('<script type="application/json">'))
      expect(markup).not.toContain('<mb-canary')
      expect(markup).not.toContain(payload)
    }), { numRuns: 200 })
  })

  it('never renders a link a browser would execute', async () => {
    const scheme = fc.constantFrom('javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'jAvAsCrIpT\n:alert(1)')
    await fc.assert(fc.asyncProperty(shape, scheme, async (spec, payload) => {
      const html = await poisoned(spec, payload)
      const markup = html.slice(0, html.indexOf('<script type="application/json">'))
      for (const [, href] of markup.matchAll(/href="([^"]*)"/g)) {
        expect(href).toMatch(/^(?:https?:|mailto:|[./#?]|$)/i)
      }
    }), { numRuns: 100 })
  })
})

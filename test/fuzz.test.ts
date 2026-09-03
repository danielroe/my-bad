import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi, renderOverlay, renderPage, serializeReport, toMarkdown } from '../src'
import { stripAnsi } from '../src/render/ansi/style'
import { escapeHtml } from '../src/render/html/escape'
import { highlightLine } from '../src/render/html/highlight'
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

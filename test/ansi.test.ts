import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderString } from 'ansivision'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi } from '../src'
import { stripAnsi } from '../src/render/ansi/style'

const fixtures = fileURLToPath(new URL('./fixtures/basic/', import.meta.url))

async function fixtureError(fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, 'sidecar', fn])
  const revive = (data: any): Error => {
    const error = new Error(data.message, data.cause ? { cause: revive(data.cause) } : undefined)
    error.name = data.name
    error.stack = data.stack
    return error
  }
  return revive(JSON.parse(stdout))
}

async function terminal(output: string) {
  const rendered = await renderString(output)
  return { text: rendered.currentFrame, styleAt: (line: number, col: number) => rendered.getStyleAtPosition(line, col) }
}

describe('renderAnsi', () => {
  it('renders a sourcemapped error with snippet and collapsed frames', async () => {
    const report = await createReport(await fixtureError('withCause'), { cwd: fixtures })
    const output = renderAnsi(report, { cwd: fixtures, colors: true, hyperlinks: true, width: 100 })
    expect(output).toContain(`\u001B]8;;file://${fixtures}src/thrower.ts#L23,11\u0007`)
    const { text, styleAt } = await terminal(output)
    expect(text.replaceAll(fixtures, '<fixtures>/')).toMatchInlineSnapshot(`
      "✖ Error: Failed to load widget

          21 │   }
          22 │   catch (error) {
        › 23 │     throw new Error('Failed to load widget', { cause: error })
             │           ^
          24 │   }
          25 │   throw new Error('unreachable')

        at Module.withCause src/thrower.ts:23:11
        at async main run.mjs:16:5

        Caused by: TypeError: Widget needs a name

            2 │   constructor(public name: string) {
            3 │     if (!name) {
          › 4 │       throw new TypeError('Widget needs a name')
              │             ^
            5 │     }
            6 │   }

          at new Widget src/thrower.ts:4:13
          at makeWidget src/thrower.ts:10:10
          at loadWidget src/thrower.ts:15:10
          at async Module.withCause src/thrower.ts:20:5
          at async main run.mjs:16:5"
    `)
    expect(styleAt(0, 0)).toMatchObject({ foreground: 1 })
    expect(styleAt(0, 2)).toMatchObject({ foreground: 1, bold: true })
    const errorLine = text.split('\n').findIndex(line => line.includes('› 23'))
    expect(styleAt(errorLine, 4)).toMatchObject({ foreground: 1 })
  })

  it('honours colors: false', async () => {
    const report = await createReport(await fixtureError('makeWidget'), { cwd: fixtures })
    const output = renderAnsi(report, { cwd: fixtures, colors: false, width: 100 })
    expect(output).not.toContain('\u001B[')
  })

  it('renders hint, docs, trace and warnings', async () => {
    const report = await createReport(new Error('Careful'), { loaders: [], snippets: false, kind: 'warning' })
    report.frames = []
    report.hint = 'Try turning it off and on again.'
    report.docsUrl = 'https://example.com/docs/e1'
    report.code = 'E1'
    report.trace = [{ label: '<App>' }, { label: '<NuxtPage>' }]
    const { text, styleAt } = await terminal(renderAnsi(report, { colors: true, width: 80 }))
    expect(text).toMatchInlineSnapshot(`
      "⚠ Error [E1]: Careful

        ℹ Try turning it off and on again.
        → https://example.com/docs/e1

        <App> › <NuxtPage>"
    `)
    expect(styleAt(0, 0)).toMatchObject({ foreground: 3 })
  })
})

describe('renderAnsi hint wrapping', () => {
  it('marks only the first line of a wrapped hint', async () => {
    const report = await createReport(new Error('Careful'), { loaders: [], snippets: false })
    report.frames = []
    report.hint = 'The widget factory received an empty name, so check the name prop passed from the parent component.'
    const lines = renderAnsi(report, { colors: false, width: 60 }).split('\n').filter(line => line.trim())
    expect(lines.filter(line => line.includes('\u2139'))).toHaveLength(1)
    expect(lines.at(-1)).toMatch(/^ {4}\w/)
  })
})

describe('stripAnsi', () => {
  it('removes hyperlinks as well as colours', async () => {
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })
    report.docsUrl = 'https://nuxt.com/docs/errors/e1'
    report.frames = [{ file: '/tmp/a,b.ts', line: 1, column: 2, function: 'f', type: 'app' }]
    const output = renderAnsi(report, { cwd: '/tmp', colors: true, hyperlinks: true, width: 80 })
    expect(output).toContain('\u001B]8;;')
    expect(stripAnsi(output)).not.toContain('\u001B')
    expect(stripAnsi(output).split('\n').filter(Boolean)).toEqual([
      '✖ Error: boom',
      '  → https://nuxt.com/docs/errors/e1',
      '  at f a,b.ts:1:2',
    ])
  })
})

describe('renderAnsi icon option', () => {
  it('omits the glyph for loggers that print their own badge', async () => {
    const report = await createReport(new Error('plain'), { loaders: [], snippets: false })
    expect(renderAnsi(report, { colors: false, icon: false }).startsWith('Error: plain')).toBe(true)
  })
})

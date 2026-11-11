import type { ErrorReport } from '../src'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderString } from 'ansivision'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi, toMarkdown } from '../src'
import { stripAnsi } from '../src/report/ansi'

const fixtures = fileURLToPath(new URL('./fixtures/basic/', import.meta.url))

async function fixtureError(fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, 'sidecar', fn])
  const revive = (data: any): Error => {
    const error = new Error(data.message, data.cause
      ? {
          cause: revive(data.cause),
        }
      : undefined)
    error.name = data.name
    error.stack = data.stack
    return error
  }
  return revive(JSON.parse(stdout))
}

async function terminal(output: string) {
  const rendered = await renderString(output)
  return {
    text: rendered.currentFrame,
    styleAt: (line: number, col: number) => rendered.getStyleAtPosition(line, col),
  }
}

describe('renderAnsi', () => {
  it('renders a sourcemapped error with snippet and collapsed frames', async () => {
    const report = await createReport(await fixtureError('withCause'), { cwd: fixtures })
    const output = renderAnsi(report, {
      cwd: fixtures,
      colors: true,
      hyperlinks: true,
      width: 100,
    })
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
        at async main run.mjs:23:5

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
          at async main run.mjs:23:5"
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
    report.trace = [
      { label: '<App>' },
      { label: '<NuxtPage>' },
    ]
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
    report.frames = [
      {
        file: '/tmp/a,b.ts',
        line: 1,
        column: 2,
        function: 'f',
        type: 'app',
      },
    ]
    const output = renderAnsi(report, {
      cwd: '/tmp',
      colors: true,
      hyperlinks: true,
      width: 80,
    })
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

describe('compiled-only compile errors', () => {
  it('labels the generated snippet instead of presenting it as source', async () => {
    const report = await createReport({
      name: 'RolldownError',
      message: 'Parse failed with 1 error:\nExpected `,` or `)` but found `!`',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 8, column: 39 },
      frame: '7  |      _createElementVNode("div", {\n8  |        class: _normalizeClass(_ctx.bob !)\n   |                                        ^',
    }, {
      cwd: '/proj',
      kind: 'compile',
      compiled: true,
      loaders: [],
      snippets: false,
    })
    const output = stripAnsi(renderAnsi(report, { cwd: '/proj', colors: false, width: 100 }))
    expect(output).toContain('generated code:')
    expect(output).toContain('_normalizeClass(_ctx.bob !)')
    expect(output).toContain('app/app.vue (generated 8:39)')
  })
})

describe('echoing causes', () => {
  const report = (name: string, message: string, causes: ErrorReport[] = []): ErrorReport => ({
    id: name,
    kind: 'error',
    name,
    message,
    frames: [],
    causes,
    sections: [],
    timestamp: 0,
  })

  it('renders a repeated message once and keeps what the echo wraps', () => {
    const chain = report('FetchError', 'Server error', [
      report('HTTPError', 'Server error', [
        report('TypeError', 'x is not a function'),
      ]),
    ])
    const output = stripAnsi(renderAnsi(chain, { colors: false, width: 100 }))

    expect(output.match(/Server error/g)).toHaveLength(1)
    expect(output).toContain('x is not a function')
    expect(output).not.toContain('HTTPError')
  })

  it('keeps an echoing cause that carries related errors', () => {
    const chain = report('FetchError', 'Server error', [
      {
        ...report('AggregateError', 'Server error'),
        errors: [
          report('TypeError', 'x is not a function'),
        ],
        omittedErrors: 2,
      },
    ])
    const output = stripAnsi(renderAnsi(chain, { colors: false, width: 100 }))

    expect(output).toContain('x is not a function')
    expect(output).toContain('and 2 more')
  })
})

describe('duplicate cause frames', () => {
  it('renders the innermost cause frames when they are all dependency frames', async () => {
    const inner = new TypeError('useSwitchLocalePath is not a function')
    inner.stack = 'TypeError: useSwitchLocalePath is not a function\n    at call (/proj/node_modules/@nuxtjs/i18n/dist/runtime/composables.mjs:12:34)'
    const wrapper = Object.assign(new Error('useSwitchLocalePath is not a function', { cause: inner }), { name: 'NuxtError', statusCode: 500 })
    wrapper.stack = 'NuxtError: useSwitchLocalePath is not a function\n    at createErrorFromThrown (/proj/node_modules/nuxt/dist/app/entry.js:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    const output = stripAnsi(renderAnsi(report, {
      cwd: '/proj',
      colors: false,
      verbose: true,
      width: 100,
    }))
    expect(output).toContain('@nuxtjs/i18n/dist/runtime/composables.mjs:12:34')
    expect(output).not.toContain('entry.js')
  })
})

describe('long messages', () => {
  it('truncates the message and reports how much was left out', async () => {
    const report = await createReport(new Error('L'.repeat(5000)), { loaders: [], snippets: false })
    const output = stripAnsi(renderAnsi(report, { colors: false, width: 80, maxMessageLength: 100 }))
    expect(output).toContain('4900 more characters')
    expect(output).not.toContain('L'.repeat(101))
  })

  it('prints only the first line of a multi-line message in bold', async () => {
    const report = await createReport(new Error('Two components are named Widget:\n\n - ~/a.vue\n - ~/b.vue'), { loaders: [], snippets: false })
    const output = renderAnsi(report, { colors: true, hyperlinks: false, width: 80 })
    const { text, styleAt } = await terminal(output)
    const lines = text.split('\n')
    expect(lines.slice(0, 3).map(line => line.trimEnd())).toEqual([
      '✖ Error: Two components are named Widget:',
      '   - ~/a.vue',
      '   - ~/b.vue',
    ])
    expect(styleAt(0, 10)?.bold).toBe(true)
    expect(styleAt(1, 5)?.bold).toBeFalsy()
  })
})

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/
const PAYLOAD = '\u001B\u001B[m]52;c;ZWNobyBoaQ==\u0007\u001Bc\r\b\u009B2J\u001B]0;title\u001B\\'

async function hostileReport(): Promise<ErrorReport> {
  const report = await createReport(new Error(`boom ${PAYLOAD}`), { loaders: [], snippets: false })
  Object.assign(report, {
    name: `Error${PAYLOAD}`,
    code: `E1${PAYLOAD}`,
    hint: `hint ${PAYLOAD}`,
    docsUrl: `https://example.com/${PAYLOAD}`,
    trace: [
      { label: `<App${PAYLOAD}>` },
    ],
    sections: [
      {
        id: 'a',
        title: `Title${PAYLOAD}`,
        content: { [`key${PAYLOAD}`]: `value${PAYLOAD}` },
      },
      { id: 'b', title: 'Text', content: `text${PAYLOAD}` },
    ],
    frames: [
      {
        file: '/proj/a.ts',
        displayFile: `a${PAYLOAD}.ts`,
        line: 2,
        column: 1,
        function: `fn${PAYLOAD}`,
        type: 'app',
        snippet: {
          start: 1,
          lines: [`// ${PAYLOAD}`, `const x = '${PAYLOAD}'`],
        },
      },
      { raw: `at ${PAYLOAD}`, function: `vendor${PAYLOAD}`, type: 'native' },
    ],
  } satisfies Partial<ErrorReport>)
  return report
}

describe('control characters', () => {
  it('strips sequences that an earlier removal would otherwise join', () => {
    expect(stripAnsi(`a${PAYLOAD}b`)).toBe('a]52;c;ZWNobyBoaQ==2Jb')
    expect(stripAnsi('a\tb\nc\r\n')).toBe('a\tb\nc\n')
  })

  it('removes control characters from report messages', async () => {
    const report = await createReport(new Error(`boom ${PAYLOAD}`), { loaders: [], snippets: false })
    expect(report.message).not.toMatch(CONTROL_RE)
  })

  it('removes control characters from every rendered field', async () => {
    const output = renderAnsi(await hostileReport(), {
      cwd: '/proj',
      colors: false,
      hyperlinks: false,
      verbose: true,
      width: 200,
    })
    expect(output).not.toMatch(CONTROL_RE)
    expect(output).toContain('value]52;c;ZWNobyBoaQ==2J')
  })

  it('keeps its own styling while removing injected sequences', async () => {
    const output = renderAnsi(await hostileReport(), {
      cwd: '/proj',
      colors: true,
      hyperlinks: true,
      verbose: true,
      width: 200,
    })
    expect(output).toContain('\u001B[1m')
    expect(output).toContain('\u001B]8;;https://example.com/]52;c;ZWNobyBoaQ==2J\u0007')
    // eslint-disable-next-line no-control-regex
    expect(output.replace(/\u001B\[\d+m|\u001B\]8;;[^\u0007]*\u0007/g, '')).not.toMatch(CONTROL_RE)
  })

  it('only prints finite numeric positions and counts', async () => {
    const report = await hostileReport()
    Object.assign(report, { status: `500${PAYLOAD}`, omittedErrors: `3${PAYLOAD}` })
    report.frames = [
      {
        file: '/proj/a.ts',
        line: `1${PAYLOAD}`,
        column: `2${PAYLOAD}`,
        type: 'app',
      },
      {
        file: '/proj/b.ts',
        compiled: { file: '/proj/b.js', line: `3${PAYLOAD}`, column: `4${PAYLOAD}` },
        type: 'app',
      },
    ] as unknown as ErrorReport['frames']
    const output = renderAnsi(report, {
      cwd: '/proj',
      colors: true,
      hyperlinks: true,
      width: 200,
    })
    expect(output).toContain('\u001B]8;;file:///proj/a.ts\u0007a.ts\u001B]8;;\u0007')
    expect(output).toContain('\u001B]8;;file:///proj/b.ts\u0007b.ts\u001B]8;;\u0007')
    expect(output).not.toContain('generated')
    // eslint-disable-next-line no-control-regex
    expect(output.replace(/\u001B\[\d+m|\u001B\]8;;[^\u0007]*\u0007/g, '')).not.toMatch(CONTROL_RE)
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\u001B\]8;;[^\u0007]*\u001B/)
  })

  it('keeps a valid line when the column is not a finite number', async () => {
    const report = await hostileReport()
    Object.assign(report, { status: Number.NaN, omittedErrors: Infinity })
    report.frames = [
      {
        file: '/proj/a.ts',
        line: 1,
        column: `2${PAYLOAD}`,
        type: 'app',
      },
      {
        file: '/proj/b.ts',
        compiled: { file: '/proj/b.js', line: 3, column: Number.NaN },
        type: 'app',
      },
    ] as unknown as ErrorReport['frames']
    const output = renderAnsi(report, {
      cwd: '/proj',
      colors: false,
      hyperlinks: true,
      width: 200,
    })
    expect(output).toContain('\u001B]8;;file:///proj/a.ts#L1\u0007a.ts:1\u001B]8;;\u0007')
    expect(stripAnsi(output)).toContain('b.ts (generated 3)')
    expect(output).not.toMatch(/NaN|Infinity/)
    // eslint-disable-next-line no-control-regex
    expect(output.replace(/\u001B\]8;;[^\u0007]*\u0007/g, '')).not.toMatch(CONTROL_RE)
  })

  it('removes control characters from markdown', async () => {
    expect(toMarkdown(await hostileReport(), { cwd: '/proj', allFrames: true })).not.toMatch(CONTROL_RE)
  })
})

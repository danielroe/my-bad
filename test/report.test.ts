import { execFile } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProblemReport, createReport, fsLoader, serializeReport } from '../src'

const fixtures = fileURLToPath(new URL('./fixtures/basic/', import.meta.url))

interface Thrown { name: string, message: string, stack: string, cause?: Thrown }

/** Run the fixture in a plain `node` so no test-runner sourcemap support rewrites the stack. */
async function thrown(variant: 'sidecar' | 'inline', fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, variant, fn])
  const revive = (data: Thrown): Error => {
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

describe('createReport', () => {
  it('maps frames through sidecar sourcemaps', async () => {
    const error = await thrown('sidecar', 'loadWidget')
    const report = await createReport(error, { cwd: fixtures })

    expect(report.name).toBe('TypeError')
    expect(report.message).toBe('Widget needs a name')
    const [top, second, third] = report.frames
    expect(top).toMatchObject({
      file: `${fixtures}src/thrower.ts`,
      line: 4,
      function: 'Widget',
      isConstructor: true,
      type: 'app',
    })
    expect(top!.compiled).toMatchObject({ file: `${fixtures}dist/sidecar/thrower.mjs` })
    expect(top!.snippet).toMatchObject({ start: 1, lang: 'ts' })
    expect(top!.snippet!.lines[3]).toContain('throw new TypeError')
    expect(top!.snippet!.lines[3]!.indexOf('new') + 1).toBe(top!.column)
    expect(second).toMatchObject({ function: 'makeWidget', line: 10 })
    expect(third).toMatchObject({ function: 'Module.loadWidget', line: 15 })
    expect(report.frames.some(frame => frame.isAsync)).toBe(true)
  })

  it('maps frames through inline sourcemaps', async () => {
    const error = await thrown('inline', 'makeWidget')
    const report = await createReport(error, { cwd: fixtures })
    expect(report.frames[0]).toMatchObject({ file: `${fixtures}src/thrower.ts`, line: 4, type: 'app' })
  })

  it('walks causes', async () => {
    const error = await thrown('sidecar', 'withCause')
    const report = await createReport(error, { cwd: fixtures })
    expect(report.message).toBe('Failed to load widget')
    expect(report.causes).toHaveLength(1)
    expect(report.causes[0]!.message).toBe('Widget needs a name')
    expect(report.causes[0]!.frames[0]!.line).toBe(4)
  })

  it('handles AggregateError and cycles', async () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    const agg = new AggregateError([a, b], 'many')
    const report = await createReport(agg, { snippets: false })
    expect(report.name).toBe('AggregateError')
    expect(report.errors).toHaveLength(2)
    expect(report.errors![0]!.causes[0]!.message).toBe('b')
    expect(report.errors![0]!.causes[0]!.causes).toHaveLength(0)
  })

  it('strips ANSI escapes from every message', async () => {
    const nested = new Error('\u001B[31mUnexpected token\u001B[39m')
    const agg = new AggregateError([
      new Error('\u001B[1mbold\u001B[22m'),
    ], '\u001B[33mmany\u001B[39m')
    agg.cause = nested
    const report = await createReport(agg, { snippets: false })
    expect(report.message).toBe('many')
    expect(report.causes[0]!.message).toBe('Unexpected token')
    expect(report.errors![0]!.message).toBe('bold')
  })

  it('classifies native and vendor frames', async () => {
    const error = new Error('x')
    error.stack = `Error: x
    at app (/proj/src/app.ts:1:1)
    at dep (/proj/node_modules/dep/index.js:2:2)
    at Array.map (<anonymous>)
    at node:internal/main:3:3
    at internalFn (/proj/src/nuxt.ts:4:4)`
    const report = await createReport(error, {
      snippets: false,
      internal: [/nuxt\.ts/],
      loaders: [],
    })
    expect(report.frames.map(f => f.type)).toEqual([
      'app',
      'vendor',
      'native',
      'native',
      'internal',
    ])
    expect(report.frames[2]!.file).toBeUndefined()
    expect(report.frames[2]!.raw).toContain('Array.map')
  })

  it('accepts Vite-style compile errors', async () => {
    const report = await createReport({
      name: 'SyntaxError',
      message: 'Unexpected token',
      plugin: 'vite:vue',
      id: '/proj/app.vue',
      loc: { file: '/proj/app.vue', line: 3, column: 5 },
      frame: '1  |  <template>\n2  |    <div>\n3  |      <p\n   |      ^\n4  |  </template>',
    })
    expect(report.kind).toBe('compile')
    expect(report.frames).toHaveLength(1)
    expect(report.frames[0]).toMatchObject({
      file: '/proj/app.vue',
      line: 3,
      column: 5,
      type: 'app',
    })
    expect(report.frames[0]!.snippet).toEqual({
      start: 1,
      lines: [
        '<template>',
        '  <div>',
        '    <p',
        '</template>',
      ],
      lang: 'vue',
    })
  })

  it('reads indentation and the caret column from a frame with a single-space gutter', async () => {
    const report = await createReport({
      message: 'Unexpected token',
      id: '/proj/a.ts',
      frame: '1 | if (a) {\n2 |   return b +\n  |            ^\n3 | }',
    }, { kind: 'compile' })
    expect(report.frames[0]).toMatchObject({ line: 2, column: 12 })
    expect(report.frames[0]!.snippet!.lines).toEqual([
      'if (a) {',
      '  return b +',
      '}',
    ])
  })

  it.each([
    ['unmarked', '1 |   foo()\n  |   ^\n2 |   bar()'],
    ['Babel', '> 1 |   foo()\n    |   ^\n  2 |   bar()'],
  ])('keeps the indentation of a single-space frame whose every line is indented (%s)', async (_, frame) => {
    const report = await createReport({ message: 'Unexpected token', id: '/proj/a.ts', frame }, { kind: 'compile' })
    expect(report.frames[0]).toMatchObject({ line: 1, column: 3 })
    expect(report.frames[0]!.snippet!.lines).toEqual(['  foo()', '  bar()'])
  })

  it('keeps the marked line of a frame that marks the error line with `>`', async () => {
    const report = await createReport({
      message: 'Unexpected token',
      id: '/proj/a.ts',
      frame: '  1 | if (a) {\n> 2 |   return b +\n    |            ^\n  3 | }',
    }, { kind: 'compile' })
    expect(report.frames[0]).toMatchObject({ line: 2, column: 12 })
    expect(report.frames[0]!.snippet!.lines).toEqual([
      'if (a) {',
      '  return b +',
      '}',
    ])
  })

  it('locates a compile-shaped warning, and names it after its kind', async () => {
    const report = await createReport({
      message: '<p> cannot be child of <p>, according to HTML specifications.',
      plugin: 'vite:vue',
      id: '/proj/app.vue',
      frame: '1  |  <template>\n2  |    <p><p>x</p></p>\n   |       ^\n3  |  </template>',
    }, { kind: 'warning' })
    expect(report).toMatchObject({ kind: 'warning', name: 'Warning', message: '<p> cannot be child of <p>, according to HTML specifications.' })
    expect(report.frames).toEqual([
      expect.objectContaining({
        file: '/proj/app.vue',
        line: 2,
        column: 6,
        type: 'app',
      }),
    ])
    expect((await createReport(new Error('careful'), { kind: 'warning', snippets: false })).name).toBe('Error')
  })

  it('strips an embedded code frame from a compile-shaped warning message', async () => {
    const prose = '<p> cannot be child of <p>, according to HTML specifications.'
    const frame = '1  |  <template>\n2  |    <p><p>x</p></p>\n   |       ^\n3  |  </template>'
    const report = await createReport({ message: `${prose}\n${frame}`, id: '/proj/app.vue', frame }, { kind: 'warning', loaders: [] })
    expect(report.message).toBe(prose)
  })

  it('keeps a declared location ahead of the stack, and drops the stack of a compile error', async () => {
    const input = {
      name: 'TypeError',
      message: 'x is undefined',
      id: '/proj/app.vue',
      loc: { file: '/proj/app.vue', line: 2, column: 3 },
      stack: 'TypeError: x is undefined\n    at render (/proj/node_modules/dep/index.js:10:5)',
    }
    const report = await createReport(input, { kind: 'error', loaders: [], snippets: false })
    expect(report.kind).toBe('error')
    expect(report.frames.map(frame => [frame.file, frame.line, frame.type])).toEqual([
      ['/proj/app.vue', 2, 'app'],
      ['/proj/node_modules/dep/index.js', 10, 'vendor'],
    ])

    for (const kind of ['compile', undefined] as const) {
      const compiled = await createReport({
        ...input,
        sources: ['/proj/other.vue'],
      }, {
        kind,
        loaders: [
          {
            name: 'memory',
            read: () => 'a\nb\n',
          },
        ],
        snippets: false,
      })
      expect(compiled.kind).toBe('compile')
      expect(compiled.frames.map(frame => frame.file)).toEqual(['/proj/app.vue', '/proj/other.vue'])
    }
  })

  it('keeps the compile-shaped location first when sources are given too', async () => {
    const input = {
      message: 'Unexpected token',
      id: '/proj/app.vue',
      loc: { file: '/proj/app.vue', line: 2, column: 3 },
      sources: ['/proj/other.vue'],
    }
    const loaders = [
      {
        name: 'memory',
        read: () => '<template>\n  <p\n</template>\n',
      },
    ]
    const report = await createReport(input, { kind: 'warning', loaders })
    expect(report.frames.map(frame => frame.file)).toEqual(['/proj/app.vue', '/proj/other.vue'])
    const { sources: _, ...located } = input
    expect(report.id).toBe((await createReport(located, { kind: 'warning', loaders })).id)
  })

  it('derives the location of a compile error from its code frame', async () => {
    const report = await createReport({
      message: 'Interpolation end sign was not found.',
      plugin: 'vite:vue',
      id: '/proj/app.vue',
      frame: '1  |  <template>\n2  |    <div>{{ oops </div>\n   |          ^\n3  |  </template>',
    })
    expect(report.kind).toBe('compile')
    expect(report.frames[0]).toMatchObject({ file: '/proj/app.vue', line: 2, column: 9 })
  })

  it('picks up status, code and data', async () => {
    const error = Object.assign(new Error('Not found'), {
      statusCode: 404,
      code: 'E404',
      data: { path: '/x' },
    })
    const report = await createReport(error, { snippets: false, loaders: [] })
    expect(report).toMatchObject({ status: 404, code: 'E404' })
    expect(report.sections[0]).toEqual({
      id: 'data',
      title: 'Data',
      content: { path: '/x' },
    })
  })

  it('serialises with relative paths', async () => {
    const error = await thrown('sidecar', 'makeWidget')
    const report = await createReport(error, { cwd: fixtures })
    const json = JSON.parse(JSON.stringify(serializeReport(report, { cwd: fixtures, snippets: false })))
    expect(json.frames[0].file).toBe('./src/thrower.ts')
    expect(json.frames[0].compiled.file).toBe('./dist/sidecar/thrower.mjs')
    expect(json.frames[0].snippet).toBeUndefined()
    expect(json.id).toBe(report.id)
  })
})

describe('compile error hoisting', () => {
  it('promotes a wrapped compile error to the top of the report', async () => {
    const compile = Object.assign(new SyntaxError('Element is missing end tag.'), {
      plugin: 'vite:vue',
      id: '/proj/pages/broken.vue',
      loc: { file: '/proj/pages/broken.vue', line: 3, column: 5 },
      frame: '2  |  <div>\n3  |      <p\n   |      ^',
    })
    const wrapper = Object.assign(new Error('Internal Server Error'), { name: 'HTTPError', statusCode: 500, cause: compile })
    wrapper.stack = 'HTTPError: Internal Server Error\n    at node:internal/main:1:1'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.kind).toBe('compile')
    expect(report.message).toBe('Element is missing end tag.')
    expect(report.status).toBe(500)
    expect(report.frames[0]).toMatchObject({ file: '/proj/pages/broken.vue', line: 3 })
    expect(report.causes.map(cause => cause.name)).toEqual(['HTTPError'])
  })

  it('leaves errors with app frames alone', async () => {
    const compile = {
      message: 'bad',
      loc: { file: '/proj/a.vue', line: 1, column: 1 },
    }
    const wrapper = Object.assign(new Error('outer'), { cause: compile })
    wrapper.stack = 'Error: outer\n    at handler (/proj/server.ts:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.kind).toBe('error')
    expect(report.causes[0]!.kind).toBe('compile')
  })
})

describe('fixture freshness', () => {
  it('basic fixture sourcemap embeds the current source', async () => {
    const { readFile } = await import('node:fs/promises')
    const map = JSON.parse(await readFile(`${fixtures}dist/sidecar/thrower.mjs.map`, 'utf8'))
    const source = await readFile(`${fixtures}src/thrower.ts`, 'utf8')
    expect(map.sourcesContent[0]).toBe(source)
  })
})

describe('duplicate causes', () => {
  it('merges a wrapper whose cause repeats its message', async () => {
    const inner = Object.assign(new TypeError('Widget needs a name'), { code: 'E1' })
    inner.stack = 'TypeError: Widget needs a name\n    at make (/proj/src/widget.ts:4:13)'
    const wrapper = Object.assign(new Error('Widget needs a name', { cause: inner }), { name: 'HTTPError', statusCode: 500 })
    wrapper.stack = 'HTTPError: Widget needs a name\n    at handler (/proj/node_modules/h3/dist/h3.mjs:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.causes).toEqual([])
    expect(report.name).toBe('TypeError')
    expect(report.status).toBe(500)
    expect(report.code).toBe('E1')
    expect(report.frames[0]).toMatchObject({ file: '/proj/src/widget.ts', type: 'app' })
  })

  it('keeps causes with different messages', async () => {
    const wrapper = new Error('outer', {
      cause: new Error('inner'),
    })
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.causes).toHaveLength(1)
  })

  it('prefers the cause frames when they are all dependency frames', async () => {
    const inner = new TypeError('useSwitchLocalePath is not a function')
    inner.stack = 'TypeError: useSwitchLocalePath is not a function\n    at call (/proj/node_modules/@nuxtjs/i18n/dist/runtime/composables.mjs:12:34)'
    const wrapper = Object.assign(new Error('useSwitchLocalePath is not a function', { cause: inner }), { name: 'NuxtError', statusCode: 500 })
    wrapper.stack = 'NuxtError: useSwitchLocalePath is not a function\n    at createErrorFromThrown (/proj/node_modules/nuxt/dist/app/entry.js:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.causes).toEqual([])
    expect(report.frames[0]).toMatchObject({ file: '/proj/node_modules/@nuxtjs/i18n/dist/runtime/composables.mjs', type: 'vendor' })
  })

  it('keeps the wrapper frames when the cause has no stack', async () => {
    const inner = new Error('Widget needs a name')
    inner.stack = undefined
    const wrapper = Object.assign(new Error('Widget needs a name', { cause: inner }), { name: 'HTTPError' })
    wrapper.stack = 'HTTPError: Widget needs a name\n    at handler (/proj/node_modules/h3/dist/h3.mjs:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.frames[0]).toMatchObject({ file: '/proj/node_modules/h3/dist/h3.mjs', type: 'vendor' })
  })

  it('keeps the wrapper app frames when the cause has only dependency frames', async () => {
    const inner = new Error('Widget needs a name')
    inner.stack = 'Error: Widget needs a name\n    at dep (/proj/node_modules/dep/index.js:2:2)'
    const wrapper = Object.assign(new Error('Widget needs a name', { cause: inner }), { name: 'HTTPError' })
    wrapper.stack = 'HTTPError: Widget needs a name\n    at handler (/proj/src/server.ts:1:1)'
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.frames[0]).toMatchObject({ file: '/proj/src/server.ts', type: 'app' })
  })
})

describe('oxc style compile errors', () => {
  it('extracts the location from the embedded frame and trims it from the message', async () => {
    const message = `Transform failed with 1 error:

[PARSE_ERROR] Unterminated string
   ╭─[ src/broken.ts:2:24 ]
   │
 2 │ ╭─▶   return \`Hello, \${name}
 3 │ ├─▶ }
   │ │
   │ ╰────
───╯`
    const report = await createReport({ message, plugin: 'vite:oxc', frame: '' }, {
      cwd: '/proj',
      kind: 'compile',
      loaders: [
        {
          name: 'memory',
          read: file => file === '/proj/src/broken.ts'
            ? 'export function greet(name: string): string {\n  return `Hello, ` + name\n}\n'
            : undefined,
        },
      ],
    })
    expect(report.kind).toBe('compile')
    expect(report.message).toBe('Transform failed with 1 error:\n\n[PARSE_ERROR] Unterminated string')
    expect(report.frames[0]).toMatchObject({
      file: '/proj/src/broken.ts',
      line: 2,
      column: 24,
      type: 'app',
    })
    expect(report.frames[0]!.snippet!.lines[1]).toContain('return `Hello')
  })
})

const rolldownFrame = '6  |      _createCommentVNode(" ... "),\n7  |      _createElementVNode("div", {\n8  |        class: _normalizeClass(_ctx.bob !)\n   |                                        ^\n9  |      }, " Nuxt Playground ", 2 /* CLASS */)\n10 |    ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))'
const rolldownBody = ' 6:     _createCommentVNode(" ... "),\n 7:     _createElementVNode("div", {\n 8:       class: _normalizeClass(_ctx.bob !)\n                                          ^\n 9:     }, " Nuxt Playground ", 2 /* CLASS */)\n10:   ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))'
const rolldownMessage = `Parse failed with 1 error:\nExpected \`,\` or \`)\` but found \`!\`\n${rolldownBody}\n${rolldownBody}`

function rolldownError() {
  return {
    name: 'RolldownError',
    code: 'PARSE_ERROR',
    message: rolldownMessage,
    id: '/proj/app/app.vue',
    loc: { file: '/proj/app/app.vue', line: 6, column: 18 },
    frame: rolldownFrame,
  }
}

describe('rolldown style compile errors', () => {
  it('keeps only the prose and takes the position from the frame caret', async () => {
    const report = await createReport(rolldownError(), { cwd: '/proj', loaders: [], snippets: false })
    expect(report.kind).toBe('compile')
    expect(report.message).toBe('Parse failed with 1 error:\nExpected `,` or `)` but found `!`')
    expect(report.frames[0]).toMatchObject({
      file: '/proj/app/app.vue',
      line: 8,
      column: 39,
      type: 'app',
    })
    expect(report.frames[0]!.snippet).toMatchObject({ start: 6 })
    expect(report.frames[0]!.snippet!.lines[2]).toBe('      class: _normalizeClass(_ctx.bob !)')
  })

  it('reads the frame out of the message when no frame is attached', async () => {
    const { frame: _frame, loc: _loc, ...error } = rolldownError()
    const report = await createReport({ ...error, frame: rolldownMessage }, { cwd: '/proj', loaders: [], snippets: false })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(report.frames[0]!.snippet!.lines).toHaveLength(5)
  })

  it('leaves numbered prose in ordinary messages alone', async () => {
    const report = await createReport({
      message: 'Request failed\nHTTP 404: not found',
      loc: { file: '/proj/a.ts', line: 1, column: 1 },
    }, { cwd: '/proj', loaders: [], snippets: false })
    expect(report.message).toBe('Request failed\nHTTP 404: not found')
  })
})

const sfc = '<script setup lang="ts">\nconst bob = ref<string>()\n</script>\n\n<template>\n  <div :class="bob !">\n    Nuxt Playground\n  </div>\n</template>\n'

function memoryLoader(contents: string, file = '/proj/app/app.vue') {
  return [
    {
      name: 'memory',
      read: (path: string) => path === file
        ? contents
        : undefined,
    },
  ]
}

describe('compiled compile errors', () => {
  it('detects a frame that does not match the file on disk', async () => {
    const report = await createReport(rolldownError(), {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    const [frame] = report.frames
    expect(frame).toMatchObject({ file: '/proj/app/app.vue', type: 'app' })
    expect(frame!.line).toBeUndefined()
    expect(frame!.snippet).toBeUndefined()
    expect(frame!.compiled).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(frame!.compiled!.snippet!.lines[2]).toBe('      class: _normalizeClass(_ctx.bob !)')
  })

  it('detects a compile error wrapped in a runtime error', async () => {
    const report = await createReport({
      name: 'HTTPError',
      message: 'Server Error',
      statusCode: 500,
      stack: 'HTTPError: Server Error\n    at /proj/node_modules/nitropack/dist/runtime/internal/error.mjs:20:11',
      cause: rolldownError(),
    }, {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    expect(report.kind).toBe('compile')
    const [frame] = report.frames
    expect(frame!.line).toBeUndefined()
    expect(frame!.snippet).toBeUndefined()
    expect(frame!.compiled).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(frame!.compiled!.snippet!.lines[2]).toBe('      class: _normalizeClass(_ctx.bob !)')
  })

  it('keeps a frame that does match the file as source', async () => {
    const report = await createReport({
      message: 'Element is missing end tag.',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 6, column: 3 },
      frame: '5  |  <template>\n6  |    <div :class="bob !">\n   |    ^\n7  |      Nuxt Playground',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    const [frame] = report.frames
    expect(frame).toMatchObject({ file: '/proj/app/app.vue', line: 6, column: 3 })
    expect(frame!.compiled).toBeUndefined()
    expect(frame!.snippet!.lines[1]).toBe('  <div :class="bob !">')
  })

  it('reports the column the compiler declared, not the caret a bundler shifted', async () => {
    const broken = '<template>\n  <div\n    does not close\n  </div>\n</template>\n'
    const report = await createReport({
      message: 'Illegal \'/\' in tags.',
      plugin: 'vite:vue',
      id: '/proj/app/app.vue',
      loc: {
        file: '/proj/app/app.vue',
        start: { line: 4, column: 4, offset: 40 },
        end: { line: 4, column: 4, offset: 40 },
      },
      frame: '2  |    <div\n3  |      does not close\n4  |    </div>\n   |     ^\n5  |  </template>\n6  |  ',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(broken),
    })
    const [frame] = report.frames
    expect(frame).toMatchObject({
      file: '/proj/app/app.vue',
      line: 4,
      column: 4,
      type: 'app',
    })
    expect(frame!.compiled).toBeUndefined()
    expect(frame!.snippet).toMatchObject({ start: 2 })
  })

  it('falls back to the caret column when the declared column is past the end of the line', async () => {
    const source = '<script setup lang="ts">\n</script>\n\n<template>\n  <div>\n    <p>a</p>\n    <span>index\n  </div>\n</template>\n'
    const report = await createReport({
      message: 'Element is missing end tag.',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 7, column: 55 },
      frame: '6  |      <p>a</p>\n7  |      <span>index\n   |      ^\n8  |    </div>',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(source),
    })
    expect(report.frames[0]).toMatchObject({
      file: '/proj/app/app.vue',
      line: 7,
      column: 5,
      type: 'app',
    })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('ignores indentation differences', async () => {
    const report = await createReport({
      message: 'Element is missing end tag.',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 6, column: 3 },
      frame: '5  |  <template>\n6  |  \t<div :class="bob !">\n   |    ^\n7  |    Nuxt Playground',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 6, column: 3 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('matches a truncated caret line on the part that survived', async () => {
    const report = await createReport({
      message: 'Element is missing end tag.',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 6, column: 3 },
      frame: '5  |  <template>\n6  |    <div :class="bob...\n   |    ^\n7  |      Nuxt Playground',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 6, column: 3 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('ignores neighbouring lines that match the source by chance', async () => {
    const source = '<script setup lang="ts">\nconst props = defineProps<{ a: string }>()\nfunction go() {\n  if (props.a) {\n    doThing()\n  }\n}\n</script>\n'
    const report = await createReport({
      name: 'RolldownError',
      message: 'Parse failed',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 8, column: 34 },
      frame: '5  |    ], 64 /* STABLE_FRAGMENT */))\n6  |  }\n7  |  }\n8  |    class: _normalizeClass(_ctx.a !)\n   |                                   ^\n9  |  }, null, 2 /* CLASS */)',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(source),
    })
    const [frame] = report.frames
    expect(frame!.line).toBeUndefined()
    expect(frame!.compiled).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 34 })
  })

  it('keeps the frame as source when the caret line proves nothing', async () => {
    const report = await createReport({
      name: 'RolldownError',
      message: 'Parse failed',
      id: '/proj/app/app.vue',
      loc: { file: '/proj/app/app.vue', line: 7, column: 1 },
      frame: '6  |    })\n7  |  }\n   |  ^\n8  |  </script>',
    }, {
      cwd: '/proj',
      loaders: memoryLoader(sfc),
    })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 7 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('leaves the frame alone when the source cannot be read', async () => {
    const report = await createReport(rolldownError(), { cwd: '/proj', loaders: [] })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('can be opted out of with compiled: false', async () => {
    const report = await createReport(rolldownError(), {
      cwd: '/proj',
      compiled: false,
      loaders: memoryLoader(sfc),
    })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('puts the position and generated frame on frame.compiled', async () => {
    const report = await createReport(rolldownError(), {
      cwd: '/proj',
      kind: 'compile',
      compiled: true,
      loaders: [],
      snippets: false,
    })
    const [frame] = report.frames
    expect(frame).toMatchObject({ file: '/proj/app/app.vue', type: 'app' })
    expect(frame!.line).toBeUndefined()
    expect(frame!.snippet).toBeUndefined()
    expect(frame!.compiled).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(frame!.compiled!.snippet!.lines[2]).toBe('      class: _normalizeClass(_ctx.bob !)')
  })

  it('honours a compiled marker on a cause, without reading the source', async () => {
    const report = await createReport({
      name: 'HTTPError',
      message: 'Server Error',
      statusCode: 500,
      stack: 'HTTPError: Server Error\n    at /proj/node_modules/nitropack/dist/runtime/internal/error.mjs:20:11',
      cause: {
        ...rolldownError(),
        compiled: true,
      },
    }, { cwd: '/proj', loaders: [] })
    expect(report.kind).toBe('compile')
    const [frame] = report.frames
    expect(frame!.line).toBeUndefined()
    expect(frame!.snippet).toBeUndefined()
    expect(frame!.compiled).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
  })

  it('lets a marker on the input override the option', async () => {
    const report = await createReport({
      ...rolldownError(),
      compiled: false,
    }, {
      cwd: '/proj',
      compiled: true,
      loaders: memoryLoader(sfc),
    })
    expect(report.frames[0]).toMatchObject({ file: '/proj/app/app.vue', line: 8, column: 39 })
    expect(report.frames[0]!.compiled).toBeUndefined()
  })

  it('never renders the marker as report data', async () => {
    const report = await createReport({
      ...rolldownError(),
      compiled: true,
    }, { cwd: '/proj', loaders: [] })
    expect(JSON.stringify(report)).not.toContain('"compiled":true')
    expect(report.sections).toEqual([])
  })

  it('ignores a marker on an ordinary runtime error', async () => {
    const error = Object.assign(new Error('boom'), { compiled: true })
    const report = await createReport(error, { cwd: '/proj', loaders: [] })
    expect(report.kind).toBe('error')
    expect(report.frames.every(frame => frame.compiled === undefined)).toBe(true)
    expect(JSON.stringify(report)).not.toContain('"compiled":true')
  })

  it('adds a source snippet when the caller knows the mapped position', async () => {
    const report = await createReport(rolldownError(), {
      cwd: '/proj',
      kind: 'compile',
      compiled: {
        sourceLoc: { line: 6, column: 16 },
      },
      loaders: memoryLoader(sfc),
    })
    const [frame] = report.frames
    expect(frame).toMatchObject({ file: '/proj/app/app.vue', line: 6, column: 16 })
    expect(frame!.snippet!.lines).toContain('  <div :class="bob !">')
    expect(frame!.compiled).toMatchObject({ line: 8, column: 39 })
  })
})

describe('positions quoted in an error message', () => {
  const dir = resolve(tmpdir(), 'my-bad-quoted-position')
  const file = resolve(dir, 'nuxt.config.ts').replaceAll('\\', '/')
  const outside = resolve(tmpdir(), 'my-bad-quoted-outside')
  const secret = resolve(outside, 'secret.ts').replaceAll('\\', '/')
  const env = resolve(dir, '.env').replaceAll('\\', '/')
  const link = resolve(dir, 'link.ts').replaceAll('\\', '/')

  beforeAll(async () => {
    await mkdir(dir, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(file, 'export default defineNuxtConfig({\n  modules: [],\n  oops\n})\n')
    await writeFile(secret, 'export const token = "s3cr3t"\n')
    await writeFile(env, 'TOKEN=1\n')
    await rm(link, { force: true })
    await symlink(secret, link)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const parserFrames = `\n    at parse (${dir}/node_modules/oxc-parser/index.js:10:5)\n    at async ModuleLoader.import (node:internal/modules/esm/loader:540:24)`

  function parserError(message: string, frames = parserFrames): Error {
    const error = new Error(message)
    error.stack = `Error: ${message}${frames}`
    return error
  }

  it.each([
    ['frames in dependencies', parserFrames],
    ['no frames', ''],
  ])('reports the quoted file as a compile error from a stack with %s', async (_, frames) => {
    const error = parserError(`ParseError: Unexpected token, expected ","\n ${file}:3:2`, frames)
    const report = await createReport(error, { cwd: dir })
    expect(report.kind).toBe('compile')
    expect(report.name).toBe('ParseError')
    expect(report.message).toBe('Unexpected token, expected ","')
    expect(report.frames).toHaveLength(1)
    expect(report.frames[0]).toMatchObject({
      file,
      line: 3,
      column: 2,
      type: 'app',
    })
    expect(report.frames[0]!.snippet!.lines).toContain('  oops')
  })

  it('ignores a single-line message, a relative path and a missing file', async () => {
    const single = await createReport(new Error(`${file}:3:2`), { cwd: dir })
    expect(single.kind).toBe('error')

    const relative = await createReport(parserError('ParseError: bad\n nuxt.config.ts:3:2'), { cwd: dir })
    expect(relative.kind).toBe('error')

    const missing = await createReport(parserError(`ParseError: bad\n ${resolve(dir, 'nope.ts').replaceAll('\\', '/')}:3:2`), { cwd: dir })
    expect(missing.kind).toBe('error')
  })

  it('ignores a position quoted by an error without a stack', async () => {
    const report = await createReport({ name: 'Error', message: `ParseError: bad\n ${file}:3:2` }, { cwd: dir })
    expect(report.kind).toBe('error')
    expect(report.frames).toEqual([])
  })

  it('ignores a position quoted by application code', async () => {
    const report = await createReport(new Error(`Invalid payload:\nx\n${file}:3:2`), { cwd: dir })
    expect(report.kind).toBe('error')
    expect(report.frames.some(frame => frame.file === file)).toBe(false)
  })

  it('ignores a quoted file outside cwd', async () => {
    const report = await createReport(parserError(`ParseError: bad\n ${secret}:1:1`), { cwd: dir })
    expect(report.kind).toBe('error')
    expect(report.frames.some(frame => frame.file === secret)).toBe(false)
  })

  it('ignores a quoted file that is not a module', async () => {
    const report = await createReport(parserError(`Invalid value:\nx\n${env}:1:1`), { cwd: dir })
    expect(report.kind).toBe('error')
    expect(report.frames.some(frame => frame.file === env)).toBe(false)
  })

  it('does not read a file outside cwd with the default loaders', async () => {
    const error = new Error('boom')
    error.stack = `Error: boom\n    at leak (${secret}:1:1)`
    const report = await createReport(error, { cwd: dir })
    const frame = report.frames.find(frame => frame.file === secret)
    expect(frame).toBeDefined()
    expect(frame!.snippet).toBeUndefined()
  })

  it('does not map a frame outside cwd with the default loaders', async () => {
    const bundle = resolve(outside, 'bundle.js').replaceAll('\\', '/')
    await writeFile(bundle, 'throw new Error("boom")\n')
    await writeFile(`${bundle}.map`, JSON.stringify({
      version: 3,
      sources: [
        file,
      ],
      names: [],
      mappings: 'AAEA',
    }))
    const error = new Error('boom')
    error.stack = `Error: boom\n    at explode (${bundle}:1:1)`

    const bounded = await createReport(error, { cwd: dir, snippets: false })
    expect(bounded.frames[0]).toMatchObject({ file: bundle, line: 1, column: 1 })

    const unbounded = await createReport(error, {
      cwd: dir,
      snippets: false,
      loaders: [
        fsLoader(),
      ],
    })
    expect(unbounded.frames[0]).toMatchObject({ file, line: 3, column: 1 })
  })

  it.each([
    ['outside cwd', secret],
    ['not a module', env],
    ['relative and outside cwd', '../my-bad-quoted-outside/secret.ts'],
    ['a symlink out of cwd with a query', 'link.ts?v=1'],
  ])('ignores a labelled frame header in a compile error message that is %s', async (_, quoted) => {
    const error = {
      message: `Unexpected token ─[ ${quoted}:1:1 ]`,
      loc: { line: 1, column: 1 },
    }
    const report = await createReport(error, {
      cwd: dir,
      loaders: [
        fsLoader(),
      ],
    })
    expect(report.frames[0]!.file).toBeUndefined()
    expect(report.frames[0]!.snippet).toBeUndefined()
  })

  it('ignores a quoted symlink out of cwd with a query', async () => {
    const report = await createReport(parserError(`ParseError: bad\n ${link}?v=1:1:1`), {
      cwd: dir,
      loaders: [
        fsLoader(),
      ],
    })
    expect(report.kind).toBe('error')
    expect(report.frames.some(frame => frame.snippet?.lines.some(line => line.includes('s3cr3t')))).toBe(false)
  })

  it('does not read a frame that is not a module', async () => {
    const error = new Error(`Invalid value:\nx\n    at a (${env}:1:1)`)
    void error.stack
    error.message = 'Request failed'
    const report = await createReport(error, { cwd: dir })
    const frame = report.frames.find(frame => frame.file === env)
    expect(frame).toBeDefined()
    expect(frame!.snippet).toBeUndefined()
  })

  it.each([
    ['rewritten', 'Request failed'],
    ['cleared', ''],
    ['shortened to a prefix of its first line', 'Invalid'],
    ['shortened to a suffix of its first line', 'value:'],
    ['shortened to a word inside its name', 'rr'],
  ])('does not read a module outside cwd named by a frame in a %s message', async (_, message) => {
    const error = new Error(`Invalid value:\nx\n    at a (${secret}:1:1)`)
    void error.stack
    error.message = message
    const report = await createReport(error, {
      cwd: dir,
      loaders: [
        fsLoader(),
      ],
    })
    const frame = report.frames.find(frame => frame.file === secret)
    expect(frame).toBeDefined()
    expect(frame!.snippet).toBeUndefined()
  })

  it.each([
    ['boom', 'Error: boom'],
    ['', 'Error'],
    ['boom', 'Error [ERR_TEST]: boom'],
    ['two\nlines', 'TypeError: two\nlines'],
  ])('reads a module outside cwd named by a frame below an unchanged message %j', async (message, header) => {
    const error = new Error(message)
    error.stack = `${header}\n    at a (${secret}:1:1)`
    const report = await createReport(error, {
      cwd: dir,
      loaders: [
        fsLoader(),
      ],
    })
    expect(report.frames.find(frame => frame.file === secret)!.snippet).toBeDefined()
  })

  describe.each([
    [
      'roots',
      () => fsLoader({
        roots: [dir, outside],
      }),
    ],
    [
      'canRead',
      () => fsLoader({
        canRead: file => !file.endsWith('.env'),
      }),
    ],
  ])('with a loader confined by %s', (_, loader) => {
    it('reads a labelled frame header outside cwd that the loader allows', async () => {
      const error = {
        message: `Unexpected token ─[ ${secret}:1:1 ]`,
        loc: { line: 1, column: 1 },
      }
      const report = await createReport(error, {
        cwd: dir,
        loaders: [
          loader(),
        ],
      })
      expect(report.frames[0]).toMatchObject({ file: secret, line: 1 })
      expect(report.frames[0]!.snippet!.lines[0]).toContain('s3cr3t')
    })

    it('reads a quoted position outside cwd that the loader allows', async () => {
      const report = await createReport(parserError(`ParseError: bad\n ${secret}:1:1`), {
        cwd: dir,
        loaders: [
          loader(),
        ],
      })
      expect(report.kind).toBe('compile')
      expect(report.frames[0]!.snippet!.lines[0]).toContain('s3cr3t')
    })

    it('reads a frame outside cwd that the loader allows below a rewritten message', async () => {
      const error = new Error(`Invalid value:\nx\n    at a (${secret}:1:1)`)
      void error.stack
      error.message = 'Request failed'
      const report = await createReport(error, {
        cwd: dir,
        loaders: [
          loader(),
        ],
      })
      expect(report.frames.find(frame => frame.file === secret)!.snippet).toBeDefined()
    })
  })

  it.each([
    [
      'outside its roots',
      secret,
      () => fsLoader({
        roots: [dir],
      }),
    ],
    [
      'a symlink out of its roots with a query',
      'link.ts?v=1',
      () => fsLoader({
        roots: [dir],
      }),
    ],
    [
      'denied by canRead',
      secret,
      () => fsLoader({
        canRead: file => file !== secret,
      }),
    ],
    [
      'inside its roots but denied by canRead',
      secret,
      () => fsLoader({
        roots: [dir, outside],
        canRead: file => file !== secret,
      }),
    ],
    [
      'when canRead throws',
      secret,
      () => fsLoader({
        canRead: () => {
          throw new Error('nope')
        },
      }),
    ],
  ])('ignores a labelled frame header %s', async (_, quoted, loader) => {
    const error = {
      message: `Unexpected token ─[ ${quoted}:1:1 ]`,
      loc: { line: 1, column: 1 },
    }
    const report = await createReport(error, {
      cwd: dir,
      loaders: [
        loader(),
      ],
    })
    expect(report.frames[0]!.file).toBeUndefined()
    expect(report.frames[0]!.snippet).toBeUndefined()
  })

  it('reads the original source of a module frame whatever its extension', async () => {
    const page = `${dir}/page.marko`
    const error = new Error('boom')
    error.stack = `Error: boom\n    at render (${dir}/page.mjs:1:1)`
    const report = await createReport(error, {
      cwd: dir,
      loaders: [
        {
          name: 'memory',
          map: frame => ({
            ...frame,
            file: page,
            line: 1,
            column: 1,
          }),
          read: path => path === page
            ? '<h1>Hello</h1>\n'
            : undefined,
        },
      ],
    })
    expect(report.frames[0]).toMatchObject({ file: page, type: 'app' })
    expect(report.frames[0]!.snippet!.lines[0]).toBe('<h1>Hello</h1>')
  })

  it('does not parse frames out of the message', async () => {
    for (const message of [`Invalid payload: x\n    at a (${secret}:1:1)`, `\n    at a (${secret}:1:1)`]) {
      const report = await createReport(new Error(message), { cwd: dir })
      expect(report.frames.some(frame => frame.file === secret)).toBe(false)
      expect(report.frames[0]!.file).toBe(fileURLToPath(import.meta.url).replaceAll('\\', '/'))
    }
  })
})

describe('createProblemReport', () => {
  const cwd = '/proj'
  const source = 'const a = 1\nconst b: string = a\nexport {}\n'
  const memory = {
    name: 'memory',
    read: (file: string) => file === '/proj/src/a.ts'
      ? source
      : undefined,
  }

  it('gives a located problem the id createReport gives it', async () => {
    const built = await createReport({
      name: 'TS2322',
      message: 'Type \'number\' is not assignable to type \'string\'.',
      sources: ['src/a.ts:2:7'],
    }, {
      cwd,
      loaders: [memory],
      kind: 'warning',
    })
    const problem = createProblemReport({
      name: 'TS2322',
      message: 'Type \'number\' is not assignable to type \'string\'.',
      file: 'src/a.ts',
      line: 2,
      column: 7,
      kind: 'warning',
    }, { cwd })
    expect(problem.id).toBe(built.id)
    expect(problem).toMatchObject({
      kind: 'warning',
      name: 'TS2322',
      frames: [
        {
          file: '/proj/src/a.ts',
          line: 2,
          column: 7,
          type: 'app',
        },
      ],
    })
    expect(problem.frames[0]!.snippet).toBeUndefined()
  })

  it('keeps a code frame the tool rendered as the snippet', () => {
    const problem = createProblemReport({
      name: 'vue-tsc',
      message: '\u001B[31mType mismatch\u001B[39m',
      code: 'TS2322',
      docsUrl: 'https://example.com/ts2322',
      file: '/elsewhere/src/a.vue',
      line: 2,
      column: 7,
      snippet: '  1 | const a = 1\n> 2 | const b: string = a\n    |       ^\n  3 | export {}',
    }, { cwd })
    expect(problem).toMatchObject({
      kind: 'error',
      message: 'Type mismatch',
      code: 'TS2322',
      docsUrl: 'https://example.com/ts2322',
    })
    expect(problem.diagnostic).toBeUndefined()
    expect(problem.frames[0]!.snippet).toEqual({
      start: 1,
      lines: [
        'const a = 1',
        'const b: string = a',
        'export {}',
      ],
      lang: 'vue',
    })
  })

  it('keeps the indentation of a code frame with a single-space gutter', () => {
    const problem = createProblemReport({
      name: 'ESLint',
      message: 'Unreachable code.',
      file: '/proj/a.ts',
      line: 3,
      column: 5,
      snippet: '  2 | if (a) {\n> 3 |   return b\n  4 |     .c\n  5 | }',
    }, { cwd })
    expect(problem.frames[0]!.snippet!.lines).toEqual([
      'if (a) {',
      '  return b',
      '    .c',
      '}',
    ])
  })

  it('crops a structured snippet around the column before tokenizing it', () => {
    const snippet = {
      start: 7,
      lines: ['abcdefghijklmnopqrstuvwxyz'],
    }
    const problem = createProblemReport({
      name: 'Checker',
      message: 'Broken',
      file: 'C:\\proj\\a.ts',
      line: 7,
      column: 15,
      snippet,
    }, {
      cwd: '/proj',
      maxSnippetLineLength: 10,
      tokenizer: (text, lang) => lang === 'ts'
        ? [
            { type: 'keyword', text },
          ]
        : undefined,
    })
    expect(problem.frames[0]!.file).toBe('C:/proj/a.ts')
    expect(problem.frames[0]!.snippet).toEqual({
      start: 7,
      lines: ['…klmnopqr…'],
      lang: 'ts',
      offset: 9,
      tokens: [
        [
          { type: 'keyword', text: '…klmnopqr…' },
        ],
      ],
    })
    expect(snippet.lines).toEqual(['abcdefghijklmnopqrstuvwxyz'])
  })

  it('builds a report where the runtime has no `process.cwd`', () => {
    const cwd = process.cwd
    Object.assign(process, { cwd: undefined })
    try {
      expect(createProblemReport({ name: 'E1', message: 'Broken', file: '/proj/src/a.ts' }).frames[0]!.file).toBe('/proj/src/a.ts')
    }
    finally {
      Object.assign(process, { cwd })
    }
  })

  it('reports a problem with no location without frames', () => {
    const problem = createProblemReport({ name: 'E1', code: 'E1', message: 'Broken' })
    expect(problem.frames).toEqual([])
    expect(problem.diagnostic).toBe(true)
    expect(problem.id).toBe(createProblemReport({ name: 'E1', message: 'Broken' }).id)
  })
})

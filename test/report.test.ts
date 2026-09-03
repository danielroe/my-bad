import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createReport, serializeReport } from '../src'

const fixtures = fileURLToPath(new URL('./fixtures/basic/', import.meta.url))

interface Thrown { name: string, message: string, stack: string, cause?: Thrown }

/** Run the fixture in a plain `node` so no test-runner sourcemap support rewrites the stack. */
async function thrown(variant: 'sidecar' | 'inline', fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, variant, fn])
  const revive = (data: Thrown): Error => {
    const error = new Error(data.message, data.cause ? { cause: revive(data.cause) } : undefined)
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
    expect(top).toMatchObject({ file: `${fixtures}src/thrower.ts`, line: 4, function: 'Widget', isConstructor: true, type: 'app' })
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

  it('classifies native and vendor frames', async () => {
    const error = new Error('x')
    error.stack = `Error: x
    at app (/proj/src/app.ts:1:1)
    at dep (/proj/node_modules/dep/index.js:2:2)
    at Array.map (<anonymous>)
    at node:internal/main:3:3
    at internalFn (/proj/src/nuxt.ts:4:4)`
    const report = await createReport(error, { snippets: false, internal: [/nuxt\.ts/], loaders: [] })
    expect(report.frames.map(f => f.type)).toEqual(['app', 'vendor', 'native', 'native', 'internal'])
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
    expect(report.frames[0]).toMatchObject({ file: '/proj/app.vue', line: 3, column: 5, type: 'app' })
    expect(report.frames[0]!.snippet).toEqual({ start: 1, lines: ['<template>', '  <div>', '    <p', '</template>'] })
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
    const error = Object.assign(new Error('Not found'), { statusCode: 404, code: 'E404', data: { path: '/x' } })
    const report = await createReport(error, { snippets: false, loaders: [] })
    expect(report).toMatchObject({ status: 404, code: 'E404' })
    expect(report.sections[0]).toEqual({ id: 'data', title: 'Data', content: { path: '/x' } })
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
    const compile = { message: 'bad', loc: { file: '/proj/a.vue', line: 1, column: 1 } }
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
    const wrapper = new Error('outer', { cause: new Error('inner') })
    const report = await createReport(wrapper, { loaders: [], snippets: false })
    expect(report.causes).toHaveLength(1)
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
      loaders: [{ name: 'memory', read: file => file === '/proj/src/broken.ts' ? 'export function greet(name: string): string {\n  return `Hello, ` + name\n}\n' : undefined }],
    })
    expect(report.kind).toBe('compile')
    expect(report.message).toBe('Transform failed with 1 error:\n\n[PARSE_ERROR] Unterminated string')
    expect(report.frames[0]).toMatchObject({ file: '/proj/src/broken.ts', line: 2, column: 24, type: 'app' })
    expect(report.frames[0]!.snippet!.lines[1]).toContain('return `Hello')
  })
})

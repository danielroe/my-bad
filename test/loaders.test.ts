import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createReport, sourceMapLoader } from '../src'

const generated = '/proj/dist/lib.mjs'

const map = {
  version: 3,
  file: 'lib.mjs',
  sources: ['../src/lib.ts'],
  names: [],
  mappings: ';AAAO,SAAS,QAAQ,OAAe;CACrC,MAAM,IAAI,MAAM,aAAa,OAAO;AACtC',
}

const loader = sourceMapLoader({ getSourceMap: file => file === generated ? map : undefined, fs: false })

describe('sourceMapLoader', () => {
  it('maps frames with a caller-supplied map', async () => {
    const mapped = await loader.map!({ file: generated, line: 3, column: 8, type: 'app' })
    expect(mapped).toMatchObject({
      file: '/proj/src/lib.ts',
      line: 2,
      column: 9,
      compiled: { file: generated, line: 3, column: 8 },
    })
  })

  it('ignores files it has no map for', async () => {
    expect(await loader.map!({ file: '/proj/dist/other.mjs', line: 1, column: 1, type: 'app' })).toBeUndefined()
  })

  it('does not map lines the map has no segment for', async () => {
    expect(await loader.map!({ file: generated, line: 6, column: 1, type: 'app' })).toBeUndefined()
  })

  it('is used by createReport as a loader', async () => {
    const error = new Error('boom')
    error.stack = `Error: boom\n    at explode (${generated}:3:8)`
    const report = await createReport(error, { loaders: [loader], snippets: false })
    expect(report.frames[0]).toMatchObject({ file: '/proj/src/lib.ts', line: 2, column: 9, function: 'explode' })
  })
})

describe('ignore lists', () => {
  it('marks frames from ignored sources as vendor', async () => {
    const { SourceMap } = await import('node:module')
    const { mapPosition } = await import('../src/loaders/sourcemap')
    const raw = {
      version: 3,
      sources: ['app.ts', '../node_modules/lib/index.js'],
      names: [],
      mappings: 'AAAA;ACAA',
      x_google_ignoreList: [1],
    }
    const map = new SourceMap(raw as any)
    expect(mapPosition(map, raw, '/proj/dist', 1, 1)).toEqual({ file: '/proj/dist/app.ts', line: 1, column: 1 })
    expect(mapPosition(map, raw, '/proj/dist', 2, 1)).toMatchObject({ file: '/proj/node_modules/lib/index.js', ignored: true })
  })
})

describe('parseInlineSourceMap', () => {
  const base64 = Buffer.from(JSON.stringify(map)).toString('base64')

  it('recovers a map from transformed code held in memory', async () => {
    const { parseInlineSourceMap } = await import('../src')
    const code = `function explode() {}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`
    const inline = parseInlineSourceMap(code)
    expect(inline).toEqual(map)

    const inlineLoader = sourceMapLoader({ getSourceMap: () => inline, fs: false })
    expect(await inlineLoader.map!({ file: generated, line: 3, column: 8, type: 'app' })).toMatchObject({ file: '/proj/src/lib.ts', line: 2, column: 9 })
  })

  it('returns undefined for code without an inline map', async () => {
    const { parseInlineSourceMap } = await import('../src')
    expect(parseInlineSourceMap('function explode() {}\n')).toBeUndefined()
    expect(parseInlineSourceMap('//# sourceMappingURL=./lib.mjs.map\n')).toBeUndefined()
    expect(parseInlineSourceMap('//# sourceMappingURL=data:application/json;base64,notjson\n')).toBeUndefined()
  })
})

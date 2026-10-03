import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createReport, fsLoader, sourceMapLoader } from '../src'

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

  it('maps through the current map when the caller supplies a new one', async () => {
    let current = { ...map, mappings: 'AAAA' }
    const live = sourceMapLoader({ getSourceMap: () => current, fs: false })
    expect(await live.map!({ file: generated, line: 1, column: 1, type: 'app' })).toMatchObject({ line: 1 })

    current = { ...map, mappings: 'AAIA' }
    expect(await live.map!({ file: generated, line: 1, column: 1, type: 'app' })).toMatchObject({ line: 5 })
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

  it('recovers a map whose data url is longer than 8kB', async () => {
    const { parseInlineSourceMap } = await import('../src')
    const large = { ...map, sourcesContent: ['x'.repeat(20_000)] }
    const code = `function explode() {}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(large)).toString('base64')}\n`
    expect(parseInlineSourceMap(code)).toEqual(large)
  })

  it('returns undefined for code without an inline map', async () => {
    const { parseInlineSourceMap } = await import('../src')
    expect(parseInlineSourceMap('function explode() {}\n')).toBeUndefined()
    expect(parseInlineSourceMap('//# sourceMappingURL=./lib.mjs.map\n')).toBeUndefined()
    expect(parseInlineSourceMap('//# sourceMappingURL=data:application/json;base64,notjson\n')).toBeUndefined()
  })
})

describe('fsLoader cache invalidation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'my-bad-fs-'))
  const file = join(dir, 'lib.mjs')
  const sidecar = `${file}.map`

  const mapFor = (mappings: string) => JSON.stringify({ version: 3, file: 'lib.mjs', sources: ['src/lib.ts'], names: [], mappings })

  async function lineOf(): Promise<number | undefined> {
    const error = new Error('boom')
    error.stack = `Error: boom\n    at explode (${file}:1:1)`
    const report = await createReport(error, { snippets: false })
    return report.frames[0]?.line
  }

  async function write(path: string, contents: string) {
    await writeFile(path, contents, 'utf8')
    await setTimeout(10)
  }

  it('maps through the map on disk after a rebuild', async () => {
    await write(file, 'export function explode() {}\n')
    await write(sidecar, mapFor('AAAA'))
    expect(await lineOf()).toBe(1)

    await write(sidecar, mapFor('AAIA'))
    expect(await lineOf()).toBe(5)
  })

  it('falls back to an inline map once the sidecar is removed', async () => {
    const inline = Buffer.from(mapFor('AAMA')).toString('base64')
    await write(file, `export function explode() {}\n//# sourceMappingURL=data:application/json;base64,${inline}\n`)
    await rm(sidecar)
    await setTimeout(10)
    expect(await lineOf()).toBe(7)

    await write(sidecar, mapFor('AAAA'))
    expect(await lineOf()).toBe(1)
  })
})

describe('fsLoader containment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'my-bad-roots-'))
  const inside = join(dir, 'app', 'main.ts')
  const outside = join(dir, 'secret.env')

  it('reads only within the configured roots', async () => {
    await mkdir(join(dir, 'app'), { recursive: true })
    await writeFile(inside, 'const a = 1\n', 'utf8')
    await writeFile(outside, 'TOKEN=1\n', 'utf8')
    const loader = fsLoader({ roots: [join(dir, 'app')] })
    expect(await loader.read!(inside)).toBe('const a = 1\n')
    expect(await loader.read!(outside)).toBeUndefined()
    expect(await loader.read!(join(dir, 'app', '..', 'secret.env'))).toBeUndefined()
    expect(await loader.readCompiled!(outside)).toBeUndefined()
  })

  it('applies canRead after the roots check', async () => {
    const loader = fsLoader({ canRead: file => !file.endsWith('.env') })
    expect(await loader.read!(inside)).toBe('const a = 1\n')
    expect(await loader.read!(outside)).toBeUndefined()
  })

  it('denies a symlink pointing out of a root', async () => {
    const link = join(dir, 'app', 'link.env')
    await symlink(outside, link)
    const loader = fsLoader({ roots: [join(dir, 'app')] })
    expect(await loader.read!(link)).toBeUndefined()
  })

  it('reads anywhere by default', async () => {
    expect(await fsLoader().read!(outside)).toBe('TOKEN=1\n')
  })
})

describe('sourcesContent', () => {
  const contentMap = (sourcesContent: (string | null)[], extra: Record<string, unknown> = {}) => ({ ...map, sourcesContent, ...extra })
  const stackAt = (file: string, ...lines: number[]) => {
    const error = new Error('boom')
    error.stack = ['Error: boom', ...lines.map(line => `    at explode (${file}:${line}:8)`)].join('\n')
    return error
  }

  it('shows the embedded original source when it is not on disk', async () => {
    const embedded = sourceMapLoader({ getSourceMap: file => file === generated ? contentMap(['export function explode() {\n  throw new Error(\'embedded\')\n}\n']) : undefined, fs: false })
    const report = await createReport(stackAt(generated, 3), { loaders: [embedded] })
    expect(report.frames[0]).toMatchObject({ file: '/proj/src/lib.ts', line: 2 })
    expect(report.frames[0]!.snippet!.lines).toEqual(['export function explode() {', '  throw new Error(\'embedded\')', '}', ''])
  })

  it('prefers the embedded source over reading the file', async () => {
    const reads: string[] = []
    const embedded = sourceMapLoader({ getSourceMap: () => contentMap(['a\nembedded\nc']) })
    const disk = { name: 'disk', read: (file: string) => {
      reads.push(file)
      return 'a\ndisk\nc'
    } }
    const report = await createReport(stackAt(generated, 3), { loaders: [embedded, disk] })
    expect(report.frames[0]!.snippet!.lines[1]).toBe('embedded')
    expect(reads).not.toContain('/proj/src/lib.ts')
  })

  it('falls back to reading the file for empty or missing entries', async () => {
    for (const sourcesContent of [[''], [null], []]) {
      const embedded = sourceMapLoader({ getSourceMap: () => contentMap(sourcesContent), fs: false })
      const disk = { name: 'disk', read: () => 'a\ndisk\nc' }
      const report = await createReport(stackAt(generated, 3), { loaders: [embedded, disk] })
      expect(report.frames[0]!.snippet!.lines[1], JSON.stringify(sourcesContent)).toBe('disk')
    }
  })

  it('falls back to reading the file when the embedded source is shorter than the mapped line', async () => {
    const embedded = sourceMapLoader({ getSourceMap: () => contentMap(['only one line']), fs: false })
    const disk = { name: 'disk', read: () => 'a\ndisk\nc' }
    const report = await createReport(stackAt(generated, 3), { loaders: [embedded, disk] })
    expect(report.frames[0]!.snippet!.lines[1]).toBe('disk')
  })

  it('resolves sourceRoot and picks the content of each frame\'s own source', async () => {
    const raw = {
      version: 3,
      sourceRoot: '/repo/src',
      sources: ['a.ts', 'b.ts'],
      sourcesContent: ['a1\na2\na3', 'b1\nb2\nb3'],
      names: [],
      mappings: 'AACA;ACAA',
    }
    const embedded = sourceMapLoader({ getSourceMap: () => raw, fs: false })
    const report = await createReport(stackAt('/repo/dist/out.js', 1, 2), { loaders: [embedded], cwd: '/repo' })
    expect(report.frames.map(frame => [frame.file, frame.line, frame.snippet?.lines[frame.line! - frame.snippet.start]])).toEqual([
      ['/repo/src/a.ts', 2, 'a2'],
      ['/repo/src/b.ts', 2, 'b2'],
    ])
  })

  it('decodes embedded sources from every section of an index map', async () => {
    const { decodeSourceMap } = await import('../src/loaders/decode')
    const lookup = decodeSourceMap({
      sections: [
        { offset: { line: 0, column: 0 }, map: { sources: ['a.ts'], sourcesContent: ['a'], mappings: 'AAAA' } },
        { offset: { line: 1, column: 0 }, map: { sources: ['b.ts', 'c.ts'], sourcesContent: ['b', ''], mappings: 'AAAA' } },
      ],
    })
    expect(['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(source => lookup.sourceContent!(source))).toEqual(['a', 'b', undefined, undefined])
  })

  it('uses the content of the current map after a rebuild', async () => {
    let current = contentMap(['a\nbefore\nc'])
    const embedded = sourceMapLoader({ getSourceMap: () => current, fs: false })
    expect((await createReport(stackAt(generated, 3), { loaders: [embedded] })).frames[0]!.snippet!.lines[1]).toBe('before')
    current = contentMap(['a\nafter\nc'])
    expect((await createReport(stackAt(generated, 3), { loaders: [embedded] })).frames[0]!.snippet!.lines[1]).toBe('after')
  })

  it('can be turned off', async () => {
    const embedded = sourceMapLoader({ getSourceMap: () => contentMap(['a\nembedded\nc']), fs: false, sourcesContent: false })
    expect((await createReport(stackAt(generated, 3), { loaders: [embedded] })).frames[0]!.snippet).toBeUndefined()
  })

  it('only shows embedded sources that fsLoader roots allow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'my-bad-embedded-'))
    await mkdir(join(dir, 'app', 'dist'), { recursive: true })
    const bundle = join(dir, 'app', 'dist', 'out.js')
    await writeFile(bundle, 'one\ntwo\n', 'utf8')
    await writeFile(`${bundle}.map`, JSON.stringify({ version: 3, sources: ['../src/inside.ts', '../../outside.ts'], sourcesContent: ['inside1\ninside2', 'outside1\noutside2'], names: [], mappings: 'AACA;ACAA' }), 'utf8')
    const error = stackAt(bundle, 1, 2)
    const bounded = await createReport(error, { loaders: [fsLoader({ roots: [join(dir, 'app')] })], cwd: dir })
    expect(bounded.frames.map(frame => [frame.file, frame.snippet?.lines[0]])).toEqual([
      [join(dir, 'app', 'src', 'inside.ts'), 'inside1'],
      [join(dir, 'outside.ts'), undefined],
    ])
    const open = await createReport(error, { loaders: [fsLoader()], cwd: dir })
    expect(open.frames.map(frame => frame.snippet?.lines[0])).toEqual(['inside1', 'outside1'])
  })
})

describe('index maps', () => {
  const indexMap = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], sourcesContent: ['a1\na2\na3'], names: [], mappings: 'AAAA;AACA' } },
      { offset: { line: 2, column: 0 }, map: { version: 3, sourceRoot: 'lib', sources: ['b.ts', '../node_modules/dep/c.js'], sourcesContent: ['b1\nb2', 'c1'], names: [], mappings: 'AAAA;ACAA', ignoreList: [1] } },
    ],
  }
  const stackAt = (file: string, ...lines: number[]) => {
    const error = new Error('boom')
    error.stack = ['Error: boom', ...lines.map(line => `    at fn${line} (${file}:${line}:1)`)].join('\n')
    return error
  }

  it('maps frames through every section with its embedded sources', async () => {
    const loader = sourceMapLoader({ getSourceMap: () => indexMap, fs: false })
    const report = await createReport(stackAt('/proj/dist/out.js', 2, 3, 4), { loaders: [loader], cwd: '/proj' })
    expect(report.frames.map(frame => [frame.file, frame.line, frame.type, frame.snippet?.lines[frame.line! - frame.snippet.start]])).toEqual([
      ['/proj/dist/a.ts', 2, 'app', 'a2'],
      ['/proj/dist/lib/b.ts', 1, 'app', 'b1'],
      ['/proj/dist/node_modules/dep/c.js', 1, 'vendor', undefined],
    ])
  })

  it('maps through an index map read from disk when the sources are gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'my-bad-index-'))
    const bundle = join(dir, 'out.js')
    await writeFile(bundle, 'one\ntwo\nthree\nfour\n', 'utf8')
    await writeFile(`${bundle}.map`, JSON.stringify(indexMap), 'utf8')
    const report = await createReport(stackAt(bundle, 2, 3), { loaders: [fsLoader()], cwd: dir })
    expect(report.frames.map(frame => [frame.file, frame.snippet?.lines[frame.line! - frame.snippet.start], frame.compiled?.snippet?.lines[0]])).toEqual([
      [join(dir, 'a.ts'), 'a2', 'one'],
      [join(dir, 'lib', 'b.ts'), 'b1', 'one'],
    ])
  })

  it('ignores an index map without sections', async () => {
    const loader = sourceMapLoader({ getSourceMap: () => ({ version: 3, sections: [] }), fs: false })
    expect(await loader.map!({ file: '/proj/dist/out.js', line: 1, column: 1, type: 'app' })).toBeUndefined()
  })
})

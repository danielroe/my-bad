import type { ViteDevServer } from 'vite'
import type { Frame } from '../src/types'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReport } from '../src'
import * as decode from '../src/loaders/decode'
import * as fs from '../src/loaders/fs'
import { viteLoader } from '../src/vite/loader'

vi.mock('../src/loaders/decode', async importOriginal => ({ ...await importOriginal<typeof decode>(), decodeSourceMap: vi.fn((await importOriginal<typeof decode>()).decodeSourceMap) }))
vi.mock('../src/loaders/fs', async importOriginal => ({ ...await importOriginal<typeof fs>(), parseInlineSourceMap: vi.fn((await importOriginal<typeof fs>()).parseInlineSourceMap) }))

const file = '/proj/src/page.ts'
const source = 'export function page() {\n  throw new Error(\'from source\')\n}\n'

interface Result { code: string, map: unknown }

/** Transformed code with a module-runner style inline map, offset by `wrapper` lines. */
function transform(wrapper: number, sourcesContent: (string | null)[] = [source]): Result {
  const map = { version: 3, sources: [file], sourcesContent, names: [], mappings: `${';'.repeat(wrapper)}AAAA;AACA;AACA` }
  const code = `${'// wrapper\n'.repeat(wrapper)}export function page() {\n  throw new Error('from source')\n}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
  return { code, map: { ...map, mappings: 'AAAA;AACA;AACA' } }
}

function fakeServer(mod: { file: string | null, id: string, ssrTransformResult: Result | null }): ViteDevServer {
  return {
    moduleGraph: {
      getModulesByFile: (path: string) => path === mod.file ? new Set([mod]) : undefined,
      getModuleById: (id: string) => id === mod.id ? mod : undefined,
    },
  } as unknown as ViteDevServer
}

function thrownAt(path: string, ...lines: number[]): Error {
  const error = new Error('boom')
  error.stack = ['Error: boom', ...lines.map(line => `    at page (${path}:${line}:9)`)].join('\n')
  return error
}

beforeEach(() => {
  vi.mocked(decode.decodeSourceMap).mockClear()
  vi.mocked(fs.parseInlineSourceMap).mockClear()
})

describe('viteLoader map cache', () => {
  it('decodes a transform result once across frames and reports', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1) }
    const loader = viteLoader(fakeServer(mod), { fs: false })
    for (let i = 0; i < 3; i++) {
      const report = await createReport(thrownAt(file, 3, 3, 2), { loaders: [loader], snippets: false })
      expect(report.frames.map(frame => frame.line)).toEqual([2, 2, 1])
    }
    expect(decode.decodeSourceMap).toHaveBeenCalledTimes(1)
    expect(fs.parseInlineSourceMap).toHaveBeenCalledTimes(1)
  })

  it('shares decoded maps between loader instances', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1) }
    await viteLoader(fakeServer(mod)).map!({ file, line: 3, column: 9, type: 'app' })
    await viteLoader(fakeServer(mod)).map!({ file, line: 3, column: 9, type: 'app' })
    expect(decode.decodeSourceMap).toHaveBeenCalledTimes(1)
  })

  it('decodes again when the module is transformed again', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1) }
    const loader = viteLoader(fakeServer(mod), { fs: false })
    expect(await loader.map!({ file, line: 3, column: 9, type: 'app' })).toMatchObject({ line: 2 })
    mod.ssrTransformResult = transform(2)
    expect(await loader.map!({ file, line: 4, column: 9, type: 'app' })).toMatchObject({ line: 2 })
    expect(decode.decodeSourceMap).toHaveBeenCalledTimes(2)
  })

  it('decodes again when the module runner rewrites the code in place', async () => {
    const result = transform(0)
    result.code = result.code.replace(/\/\/# sourceMappingURL=.*\n$/, '')
    const mod = { file, id: file, ssrTransformResult: result }
    const loader = viteLoader(fakeServer(mod), { fs: false })
    expect(await loader.map!({ file, line: 2, column: 9, type: 'app' })).toMatchObject({ line: 2 })
    result.code = transform(1).code
    expect(await loader.map!({ file, line: 3, column: 9, type: 'app' })).toMatchObject({ line: 2 })
    expect(decode.decodeSourceMap).toHaveBeenCalledTimes(2)
  })

  it('remembers results without a usable map', async () => {
    const mod = { file, id: file, ssrTransformResult: { code: 'export {}\n', map: null } }
    const loader = viteLoader(fakeServer(mod), { fs: false })
    await createReport(thrownAt(file, 1, 1, 1), { loaders: [loader], snippets: false })
    expect(fs.parseInlineSourceMap).toHaveBeenCalledTimes(1)
  })
})

describe('viteLoader sourcesContent', () => {
  it('shows the original source of a module whose file is not on disk', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1) }
    const report = await createReport(thrownAt(file, 3), { loaders: [viteLoader(fakeServer(mod))], cwd: '/proj' })
    expect(report.frames[0]).toMatchObject({ file, line: 2 })
    expect(report.frames[0]!.snippet!.lines[1]).toBe('  throw new Error(\'from source\')')
    expect(report.frames[0]!.compiled!.snippet!.lines[0]).toBe('// wrapper')
  })

  it('shows the original source of a virtual module instead of its transformed code', async () => {
    const id = 'virtual:page'
    const result = transform(1)
    const map = { version: 3, sources: [id], sourcesContent: ['original 1\noriginal 2\n'], names: [], mappings: ';AAAA;AACA' }
    result.code = `// wrapper\ncompiled 1\ncompiled 2\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
    const mod = { file: null, id, ssrTransformResult: result }
    const report = await createReport(thrownAt(id, 3), { loaders: [viteLoader(fakeServer(mod))], cwd: '/proj' })
    expect(report.frames[0]).toMatchObject({ line: 2 })
    expect(report.frames[0]!.snippet!.lines).toContain('original 2')
  })

  it('reads the file when the map embeds no content', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1, [null]) }
    const disk = { name: 'disk', read: () => 'disk 1\ndisk 2\n' }
    const report = await createReport(thrownAt(file, 3), { loaders: [viteLoader(fakeServer(mod), { fs: false }), disk], cwd: '/proj' })
    expect(report.frames[0]!.snippet!.lines[1]).toBe('disk 2')
  })

  it('maps through an inline index map and its sections\' embedded sources', async () => {
    const index = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: [], names: [], mappings: '' } },
        { offset: { line: 1, column: 0 }, map: { version: 3, sources: [file], sourcesContent: [source], names: [], mappings: 'AAAA;AACA' } },
      ],
    }
    const code = `// wrapper\nexport function page() {\n  throw new Error('from source')\n}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(index)).toString('base64')}\n`
    const mod = { file, id: file, ssrTransformResult: { code, map: null } }
    const report = await createReport(thrownAt(file, 3), { loaders: [viteLoader(fakeServer(mod), { fs: false })], cwd: '/proj' })
    expect(report.frames[0]).toMatchObject({ file, line: 2 })
    expect(report.frames[0]!.snippet!.lines[1]).toBe('  throw new Error(\'from source\')')
  })

  const inline = (map: object, code = '// wrapper\nexport function page() {\n  throw new Error(\'from source\')\n}\n') => `${code}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
  const identity = () => ({ file, id: file, ssrTransformResult: { code: inline({ version: 3, sources: [file], sourcesContent: [source], names: [], mappings: 'AAAA;AACA;AACA' }, source), map: null } })
  const errorAt = (position: string) => Object.assign(new Error('boom'), { stack: `Error: boom\n    at page (${position})` })

  it('keeps the embedded source of a frame that is already original', async () => {
    const loader = viteLoader(fakeServer(identity()), { fs: false })
    expect(await loader.map!({ file, line: 2, column: 1, type: 'app' })).toBeUndefined()
    const report = await createReport(errorAt(`${file}:2:1`), { loaders: [loader], cwd: '/proj' })
    expect(report.frames[0]).toMatchObject({ file, line: 2, column: 1 })
    expect(report.frames[0]!.compiled).toBeUndefined()
    expect(report.frames[0]!.snippet!.lines[1]).toBe('  throw new Error(\'from source\')')
  })

  it('drops that embedded source when a later loader moves the frame', async () => {
    const other = '/proj/src/other.ts'
    const disk = { name: 'disk', read: (path: string) => path === other ? 'other 1\nother 2\n' : undefined }
    const replacing = { name: 'replacing', map: (frame: Frame) => ({ ...frame, file: other }) }
    const rewriting = { name: 'rewriting', map: (frame: Frame) => Object.assign(frame, { file: other }) }
    for (const later of [replacing, rewriting]) {
      const report = await createReport(errorAt(`${file}:2:1`), { loaders: [viteLoader(fakeServer(identity()), { fs: false }), later, disk], cwd: '/proj' })
      expect(report.frames[0]!.file, later.name).toBe(other)
      expect(report.frames[0]!.snippet!.lines[1], later.name).toBe('other 2')
    }
  })

  it('resolves sources against a relative sourceRoot', async () => {
    const shared = 'export const util = 1\nthrow new Error(\'shared\')\n'
    const top = { version: 3, sourceRoot: '../shared', sources: ['util.ts'], sourcesContent: [shared], names: [], mappings: ';AAAA;AACA' }
    const sectioned = { version: 3, sections: [{ offset: { line: 1, column: 0 }, map: { version: 3, sourceRoot: '../shared/', sources: ['util.ts'], sourcesContent: [shared], names: [], mappings: 'AAAA;AACA' } }] }
    for (const map of [top, sectioned]) {
      const mod = { file, id: file, ssrTransformResult: { code: inline(map), map: null } }
      const report = await createReport(thrownAt(file, 3), { loaders: [viteLoader(fakeServer(mod), { fs: false })], cwd: '/proj' })
      expect(report.frames[0], JSON.stringify(map)).toMatchObject({ file: '/proj/shared/util.ts', line: 2 })
      expect(report.frames[0]!.snippet!.lines[1]).toBe('throw new Error(\'shared\')')
    }
  })

  it('follows the latest transform', async () => {
    const mod = { file, id: file, ssrTransformResult: transform(1) }
    const loader = viteLoader(fakeServer(mod))
    await createReport(thrownAt(file, 3), { loaders: [loader] })
    mod.ssrTransformResult = transform(1, [source.replace('from source', 'edited')])
    const report = await createReport(thrownAt(file, 3), { loaders: [loader] })
    expect(report.frames[0]!.snippet!.lines[1]).toContain('edited')
  })
})

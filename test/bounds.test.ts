import type { SourceLoader } from '../src/types'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi, renderPage, toMarkdown } from '../src'

const options = { loaders: [], snippets: false, cwd: '/proj' }

function stack(frames: number): string {
  return ['Error: boom', ...Array.from({ length: frames }, (_, index) => `    at fn${index} (/proj/src/file${index}.ts:${index + 1}:1)`)].join('\n')
}

describe('report bounds', () => {
  it('caps the number of related errors per level', async () => {
    const error = new AggregateError(Array.from({ length: 50 }, (_, index) => new Error(`nested ${index}`)), 'many')
    const report = await createReport(error, options)
    expect(report.errors).toHaveLength(20)
    expect(report.omittedErrors).toBe(30)
  })

  it('honours maxErrors and leaves omittedErrors unset below it', async () => {
    const error = new AggregateError([new Error('a'), new Error('b'), new Error('c')], 'many')
    expect(await createReport(error, { ...options, maxErrors: 2 })).toMatchObject({ omittedErrors: 1 })
    expect((await createReport(error, { ...options, maxErrors: 3 })).omittedErrors).toBeUndefined()
  })

  it('keeps frames past the mapping budget unmapped', async () => {
    const mapped: string[] = []
    const loader: SourceLoader = {
      name: 'test',
      map: (frame) => {
        mapped.push(frame.file!)
        return { ...frame, file: `${frame.file}.mapped` }
      },
    }
    const error = new Error('boom')
    error.stack = stack(10)
    const report = await createReport(error, { ...options, loaders: [loader], maxMappedFrames: 3 })
    expect(report.frames).toHaveLength(10)
    expect(mapped).toHaveLength(3)
    expect(report.frames[2]!.file).toBe('/proj/src/file2.ts.mapped')
    expect(report.frames[3]!.file).toBe('/proj/src/file3.ts')
    expect(report.frames[3]!.type).toBe('app')
  })

  it('shares the frame budget across causes', async () => {
    const mapped: string[] = []
    const loader: SourceLoader = {
      name: 'test',
      map: (frame) => {
        mapped.push(frame.file!)
        return undefined
      },
    }
    const cause = new Error('cause')
    cause.stack = stack(5)
    const error = new Error('boom', { cause })
    error.stack = stack(5)
    await createReport(error, { ...options, loaders: [loader], maxMappedFrames: 6 })
    expect(mapped).toHaveLength(6)
  })

  it('truncates oversized data sections and leaves small ones structured', async () => {
    const big = Object.assign(new Error('boom'), { data: { body: 'x'.repeat(5000) } })
    const content = (await createReport(big, { ...options, maxSectionLength: 100 })).sections[0]!.content
    expect(typeof content).toBe('string')
    expect(content).toContain('truncated')
    expect((content as string).length).toBeLessThan(200)

    const small = Object.assign(new Error('boom'), { data: { body: 'small' } })
    expect((await createReport(small, { ...options, maxSectionLength: 100 })).sections[0]!.content).toEqual({ body: 'small' })
  })

  it('truncates long messages', async () => {
    const report = await createReport(new Error('x'.repeat(500)), { ...options, maxMessageLength: 100 })
    expect(report.message.startsWith('x'.repeat(100))).toBe(true)
    expect(report.message).toContain('400 more characters')
  })

  it('truncates long raw stacks', async () => {
    const error = new Error('boom')
    error.stack = stack(400)
    const report = await createReport(error, { ...options, maxRawStackLength: 500 })
    expect(report.rawStack!.length).toBeLessThan(600)
    expect(report.rawStack).toContain('truncated')
  })
})

describe('snippet bounds', () => {
  const lines = (count: number, text = (n: number) => `line ${n}`) => Array.from({ length: count }, (_, index) => text(index + 1)).join('\n')
  const memory = (files: Record<string, string>, compiled: Record<string, string> = {}): SourceLoader => ({
    name: 'memory',
    read: file => files[file],
    readCompiled: file => compiled[file],
    map: frame => frame.file?.endsWith('.js') ? { ...frame, file: frame.file.replace(/\.js$/, '.ts'), compiled: { file: frame.file, line: frame.line, column: frame.column } } : undefined,
  })
  const snippetsOf = (report: Awaited<ReturnType<typeof createReport>>) => report.frames.map(frame => [!!frame.snippet, !!frame.compiled?.snippet])

  it('caps snippets across the report, counting compiled snippets and keeping the topmost', async () => {
    const files = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`/proj/src/file${index}.ts`, lines(20)]))
    const compiled = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`/proj/src/file${index}.js`, lines(20)]))
    const error = new Error('boom', { cause: Object.assign(new Error('cause'), { stack: 'Error: cause\n    at c (/proj/src/file3.ts:2:1)' }) })
    error.stack = ['Error: boom', ...Array.from({ length: 3 }, (_, index) => `    at fn${index} (/proj/src/file${index}.js:${index + 2}:1)`)].join('\n')
    const report = await createReport(error, { cwd: '/proj', loaders: [memory(files, compiled)], maxSnippets: 3 })
    expect(snippetsOf(report)).toEqual([[true, true], [true, false], [false, false]])
    expect(report.causes[0]!.frames[0]!.snippet).toBeUndefined()
    expect(report.frames[2]).toMatchObject({ file: '/proj/src/file2.ts', line: 4 })

    const roomy = await createReport(error, { cwd: '/proj', loaders: [memory(files, compiled)] })
    expect(snippetsOf(roomy)).toEqual([[true, true], [true, true], [true, true]])
    expect(roomy.causes[0]!.frames[0]!.snippet).toBeDefined()
  })

  it('reads no more sources than the remaining budget needs', async () => {
    const reads: string[] = []
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`/proj/src/file${index}.ts`, lines(5)]))
    const counting: SourceLoader = { name: 'counting', read: (file) => {
      reads.push(file)
      return file.endsWith('file0.ts') ? undefined : files[file]
    } }
    const error = new Error('boom')
    error.stack = ['Error: boom', ...Array.from({ length: 5 }, (_, index) => `    at fn${index} (/proj/src/file${index}.ts:2:1)`)].join('\n')
    const report = await createReport(error, { cwd: '/proj', loaders: [counting], maxSnippets: 2 })
    expect(report.frames.map(frame => !!frame.snippet)).toEqual([false, true, true, false, false])
    expect(reads).toEqual(['/proj/src/file0.ts', '/proj/src/file1.ts', '/proj/src/file2.ts'])
  })

  it('rounds fractional and invalid snippet budgets', async () => {
    const files = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`/proj/src/file${index}.ts`, lines(5)]))
    const error = new Error('boom')
    error.stack = ['Error: boom', ...Array.from({ length: 3 }, (_, index) => `    at fn${index} (/proj/src/file${index}.ts:2:1)`)].join('\n')
    for (const [max, expected] of [[0.5, 0], [1.9, 1], [-3, 0], [Number.NaN, 3], [Infinity, 3]] as const) {
      const report = await createReport(error, { cwd: '/proj', loaders: [memory(files)], maxSnippets: max })
      expect(report.frames.filter(frame => frame.snippet), String(max)).toHaveLength(expected)
    }
  }, 2000)

  it('reads every source within the budget concurrently', async () => {
    let started = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const waiting: SourceLoader = { name: 'waiting', read: async () => {
      started++
      await gate
      return lines(5)
    } }
    const error = new Error('boom')
    error.stack = ['Error: boom', ...Array.from({ length: 5 }, (_, index) => `    at fn${index} (/proj/src/file${index}.ts:2:1)`)].join('\n')
    const pending = createReport(error, { cwd: '/proj', loaders: [waiting] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(started).toBe(5)
    release()
    expect((await pending).frames.every(frame => frame.snippet)).toBe(true)
  })

  it('does not spend the budget on frames whose source cannot be read', async () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at a (/proj/src/missing.ts:2:1)\n    at b (/proj/src/present.ts:2:1)'
    const report = await createReport(error, { cwd: '/proj', loaders: [memory({ '/proj/src/present.ts': lines(5) })], maxSnippets: 1 })
    expect(report.frames.map(frame => !!frame.snippet)).toEqual([false, true])
  })

  it('counts compiler-provided frames against the budget', async () => {
    const compile = { message: 'Unexpected token', id: '/proj/src/a.ts', frame: '1 | const a =\n2 | const b = ;\n  |           ^', loc: { file: '/proj/src/a.ts', line: 2, column: 11 } }
    expect((await createReport(compile, { cwd: '/proj', loaders: [], maxSnippets: 0 })).frames[0]!.snippet).toBeUndefined()
    expect((await createReport(compile, { cwd: '/proj', loaders: [], maxSnippets: 1 })).frames[0]!.snippet!.lines).toEqual(['const a =', 'const b = ;'])
  })

  it('crops long lines around the reported column and keeps the caret on it', async () => {
    const minified = `${'a'.repeat(50_000)}THROW${'b'.repeat(50_000)}`
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at x (/proj/src/min.ts:2:50001)'
    const report = await createReport(error, { cwd: '/proj', loaders: [memory({ '/proj/src/min.ts': `short\n${minified}\nshort` })], maxSnippetLineLength: 200 })
    const snippet = report.frames[0]!.snippet!
    expect(snippet.lines.every(line => line.length <= 200)).toBe(true)
    expect(snippet.offset).toBe(49_900)
    expect(snippet.lines[1]!.slice(50_001 - 1 - snippet.offset!).startsWith('THROW')).toBe(true)
    expect(snippet.lines[1]!.startsWith('\u2026')).toBe(true)
    expect(snippet.lines[1]!.endsWith('\u2026')).toBe(true)
    expect(snippet.lines[0]).toBe('\u2026')
    expect(snippet.lines[2]).toBe('\u2026')

    const ansi = renderAnsi(report, { colors: false, width: 400, cwd: '/proj' })
    const row = ansi.split('\n').findIndex(line => line.includes('THROW'))
    const caret = ansi.split('\n')[row + 1]!
    expect(caret.indexOf('^')).toBe(ansi.split('\n')[row]!.indexOf('THROW'))

    const html = renderPage(report, { cwd: '/proj' })
    expect(html).toContain(`<span class="mb-caret" aria-hidden="true">${' '.repeat(100)}^</span>`)
  })

  it('raises tiny or invalid line lengths to a usable minimum', async () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at x (/proj/src/min.ts:1:500)'
    const loaders = [memory({ '/proj/src/min.ts': 'x'.repeat(1000) })]
    for (const [max, expected] of [[0, 2], [1, 2], [2, 2], [-5, 2], [3.7, 3], [Number.NaN, 500]] as const) {
      const line = (await createReport(error, { cwd: '/proj', loaders, maxSnippetLineLength: max })).frames[0]!.snippet!.lines[0]!
      expect(line.length, String(max)).toBe(expected)
    }
  })

  it('crops a long line from the start when the column is near it', async () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at x (/proj/src/min.ts:1:10)'
    const report = await createReport(error, { cwd: '/proj', loaders: [memory({ '/proj/src/min.ts': 'x'.repeat(10_000) })], maxSnippetLineLength: 100 })
    expect(report.frames[0]!.snippet).toMatchObject({ offset: 0, lines: [`${'x'.repeat(99)}\u2026`] })
  })

  it('leaves no lone surrogate at a cut', async () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at x (/proj/src/emoji.ts:1:400)'
    const report = await createReport(error, { cwd: '/proj', loaders: [memory({ '/proj/src/emoji.ts': '\u{1F600}'.repeat(1000) })], maxSnippetLineLength: 101 })
    const line = report.frames[0]!.snippet!.lines[0]!
    expect(line).toHaveLength(101)
    expect(() => encodeURIComponent(line)).not.toThrow()
  })

  it('crops long lines of compiler-provided frames', async () => {
    const long = `const broken = ${'a + '.repeat(5000)}0`
    const compile = { message: 'Unexpected token', id: '/proj/src/a.ts', frame: `1 | ok\n2 | ${long}\n  |       ^`, loc: { file: '/proj/src/a.ts', line: 2, column: 5 } }
    const report = await createReport(compile, { cwd: '/proj', loaders: [], maxSnippetLineLength: 80 })
    expect(report.frames[0]!.snippet).toMatchObject({ start: 1, offset: 0, lines: ['ok', `${long.slice(0, 79)}\u2026`] })
  })

  it('renders a report of many frames into very long minified lines', async () => {
    const line = Array.from({ length: 40_000 }, (_, index) => `function f${index}(a){return a+${index}}`).join(';')
    const error = new Error('minified failure')
    error.stack = ['Error: minified failure', ...Array.from({ length: 40 }, (_, index) => `    at f${index} (/proj/dist/bundle.min.ts:${1 + (index % 2)}:${1 + index * 25_000})`)].join('\n')
    const report = await createReport(error, { cwd: '/proj', loaders: [memory({ '/proj/dist/bundle.min.ts': `${line}\n${line}\n` })] })
    const html = renderPage(report, { cwd: '/proj' })
    expect(html.length).toBeLessThan(5_000_000)
    expect(JSON.stringify(report).length).toBeLessThan(500_000)
    expect(renderAnsi(report, { colors: true, cwd: '/proj' })).toContain('minified failure')
    expect(toMarkdown(report, { cwd: '/proj' })).toContain('minified failure')
  })
})

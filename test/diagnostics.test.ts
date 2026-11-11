import { describe, expect, it } from 'vitest'
import { createProblemReport, createReport, renderAnsi, renderOverlay, renderPage, toMarkdown } from '../src'
import { toHistoryEntry } from '../src/channel/protocol'
import { renderIndex } from '../src/render/html/view'
import { stripAnsi } from '../src/report/ansi'

const SOURCE = 'const props = defineProps()\nconst widget = useWidget()\nawait widget.load()\nexport {}\n'

const loaders = [
  {
    name: 'memory',
    read: (file: string) => file === '/proj/pages/index.vue'
      ? SOURCE
      : undefined,
  },
]

function diagnostic(extra: Record<string, unknown> = {}) {
  return {
    name: 'NUXT_E1001',
    code: 'NUXT_E1001',
    message: 'The widget factory received an empty name.',
    fix: 'Pass a non-empty `name` prop to `<Widget>`.',
    docs: 'https://nuxt.com/docs/4.x/errors/e1001',
    sources: ['/proj/pages/index.vue:2:16'],
    stack: 'NUXT_E1001: The widget factory received an empty name.\n    at useWidget (/proj/node_modules/nuxt/dist/app/widget.js:1:1)',
    ...extra,
  }
}

describe('diagnostic errors', () => {
  it('reads fix, docs and sources off the error', async () => {
    const report = await createReport(diagnostic(), { cwd: '/proj', loaders })
    expect(report).toMatchObject({
      name: 'NUXT_E1001',
      code: 'NUXT_E1001',
      diagnostic: true,
      message: 'The widget factory received an empty name.',
      hint: 'Pass a non-empty `name` prop to `<Widget>`.',
      docsUrl: 'https://nuxt.com/docs/4.x/errors/e1001',
    })
    expect(report.sections.some(section => section.id === 'sources')).toBe(false)
    expect(report.frames[0]).toMatchObject({
      file: '/proj/pages/index.vue',
      line: 2,
      column: 16,
      type: 'app',
    })
    expect(report.frames[0]!.snippet!.lines).toContain('const widget = useWidget()')
  })

  it('lists sources that do not resolve to a readable file', async () => {
    const report = await createReport(diagnostic({
      sources: ['/proj/pages/gone.vue:2:1', 'somewhere in the build'],
    }), { cwd: '/proj', loaders })
    expect(report.frames.every(frame => frame.type !== 'app')).toBe(true)
    expect(report.sections.find(section => section.id === 'sources')).toEqual({
      id: 'sources',
      title: 'Sources',
      content: '/proj/pages/gone.vue:2:1\nsomewhere in the build',
    })
  })

  it('reads docsUrl when the error has no docs', async () => {
    const { docs: _, ...rest } = diagnostic()
    expect((await createReport({ ...rest, docsUrl: 'https://example.com/e1' }, { cwd: '/proj', loaders })).docsUrl).toBe('https://example.com/e1')
    expect((await createReport(diagnostic({ docsUrl: 'https://example.com/e1' }), { cwd: '/proj', loaders })).docsUrl).toBe('https://nuxt.com/docs/4.x/errors/e1001')
  })

  it('reads sources with only a line, or only a file', async () => {
    const report = await createReport(diagnostic({
      sources: ['/proj/pages/index.vue:3', '/proj/pages/index.vue'],
    }), { cwd: '/proj', loaders })
    expect(report.frames.slice(0, 2)).toEqual([
      expect.objectContaining({
        file: '/proj/pages/index.vue',
        line: 3,
        type: 'app',
        snippet: expect.objectContaining({
          start: expect.any(Number),
        }),
      }),
      { file: '/proj/pages/index.vue', type: 'app' },
    ])
    expect(report.sections.some(section => section.id === 'sources')).toBe(false)
  })

  it('renders a source without a line as a reference to the file', async () => {
    const report = await createReport(diagnostic({
      sources: ['/proj/pages/index.vue'],
    }), { cwd: '/proj', loaders })
    const html = renderPage(report, { cwd: '/proj' })
    const page = html.slice(0, html.indexOf('<script type="application/json">'))
    const source = /<section class="mb-source"[^>]*data-file-only[^>]*>[\s\S]*?<\/section>/.exec(page)![0]
    expect(source).toContain('<button type="button" class="mb-loc" data-loc data-action="open" data-file="/proj/pages/index.vue" title="/proj/pages/index.vue">pages/index.vue</button>')
    expect(source).toContain('data-action="copy-location" data-file="/proj/pages/index.vue"')
    expect(source).toContain('title="Open original source in your editor"')
    expect(source).not.toContain('mb-snippet')
    expect(page).not.toContain('Source is unavailable')
  })

  it('tells apart the same diagnostic at different files, lines and columns', async () => {
    const sources = [
      '/proj/pages/index.vue',
      '/proj/pages/index.vue:2:16',
      '/proj/pages/index.vue:2:20',
      '/proj/pages/index.vue:3:16',
      '/proj/pages/other.vue',
    ]
    const read = (file: string) => file.startsWith('/proj/pages/')
      ? SOURCE
      : undefined
    const ids = await Promise.all(sources.map(async source => (await createReport(diagnostic({
      sources: [source],
    }), {
      cwd: '/proj',
      loaders: [
        { name: 'memory', read },
      ],
    })).id))
    expect(new Set(ids).size).toBe(sources.length)
  })

  it('does not mark an ordinary coded error as a diagnostic', async () => {
    const report = await createReport(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }), { cwd: '/proj', loaders: [], snippets: false })
    expect(report.diagnostic).toBeUndefined()
    expect(report.hint).toBeUndefined()
  })

  it('marks a diagnostic, and only a diagnostic, as using code spans', async () => {
    const report = await createReport(diagnostic({
      cause: new Error('Quoted `code` in a cause'),
    }), { cwd: '/proj', loaders })
    expect(report.codeSpans).toBe(true)
    expect(report.causes[0]!.codeSpans).toBeUndefined()
    expect(toHistoryEntry(report).codeSpans).toBe(true)
    expect((await createReport(new Error('Unexpected `x` and `y`'), { cwd: '/proj', loaders: [] })).codeSpans).toBeUndefined()
  })

  it('marks the top-level report as using code spans when asked', async () => {
    const report = await createReport(new Error('`defineProps` is a compiler macro', {
      cause: new Error('`x`'),
    }), { cwd: '/proj', loaders: [], codeSpans: true })
    expect(report.codeSpans).toBe(true)
    expect(report.causes[0]!.codeSpans).toBeUndefined()
    expect(createProblemReport({ name: 'Vue', message: '`defineProps` is a compiler macro' }, { codeSpans: true }).codeSpans).toBe(true)
    expect(createProblemReport({ name: 'Vue', message: '`defineProps` is a compiler macro' }).codeSpans).toBeUndefined()
  })

  it('renders code spans as code in HTML and ANSI, and keeps them in Markdown', async () => {
    const report = await createReport(diagnostic({
      message: 'The `<Widget>` factory received an empty `name`, see `',
    }), { cwd: '/proj', loaders })

    const page = renderPage(report, { cwd: '/proj' })
    expect(page).toContain('data-message>The <code>&lt;Widget&gt;</code> factory received an empty <code>name</code>, see `</h1>')
    expect(page).toContain('data-hint>Pass a non-empty <code>name</code> prop to <code>&lt;Widget&gt;</code>.')
    expect(page).toContain('<title>NUXT_E1001: The &lt;Widget&gt; factory received an empty name, see `</title>')
    expect(renderIndex({ mode: 'docked', version: '' }, { history: [], problems: [], current: report })).toContain('<span class="mb-index-title">NUXT_E1001: The <code>&lt;Widget&gt;</code> factory')

    const plain = renderAnsi(report, { cwd: '/proj', colors: false, hyperlinks: false }).split('\n')
    expect(plain[0]).toBe('✖ NUXT_E1001: The <Widget> factory received an empty name, see `')
    expect(plain).toContain('  ℹ Pass a non-empty name prop to <Widget>.')
    const coloured = renderAnsi(report, { cwd: '/proj', colors: true, hyperlinks: false })
    expect(coloured).toContain('\u001B[36m<Widget>\u001B[39m')
    expect(stripAnsi(coloured).split('\n')[0]).toBe(plain[0])

    const markdown = toMarkdown(report, { cwd: '/proj' })
    expect(markdown).toContain('The `<Widget>` factory received an empty `name`, see `')
    expect(markdown).toContain('> Pass a non-empty `name` prop to `<Widget>`.')
  })

  it('leaves backticks alone in reports that do not use code spans', async () => {
    const report = await createReport(new Error('Unexpected `x` in `y`'), { cwd: '/proj', loaders: [] })
    expect(renderPage(report, { cwd: '/proj' })).toContain('data-message>Unexpected `x` in `y`</h1>')
    expect(renderAnsi(report, { cwd: '/proj', colors: false }).split('\n')[0]).toBe('✖ Error: Unexpected `x` in `y`')
  })

  it('renders the code once in HTML, ANSI and Markdown', async () => {
    const report = await createReport(diagnostic({ status: 500 }), { cwd: '/proj', loaders })

    const page = renderPage(report, { cwd: '/proj' })
    expect(page).toContain(`<span class="mb-name" id="mb-r-${report.id}-name" data-name>Error</span>`)
    const kicker = /<p class="mb-kicker">[\s\S]*?<\/p>/.exec(page)![0]
    expect(kicker.match(/>NUXT_E1001/g)).toHaveLength(1)
    expect(page).toContain('https://nuxt.com/docs/4.x/errors/e1001')
    expect(page).toContain('Learn more')
    expect(renderOverlay(report, { cwd: '/proj' })).toContain('"docsUrl":"https://nuxt.com/docs/4.x/errors/e1001"')

    const ansi = renderAnsi(report, { cwd: '/proj', colors: false, hyperlinks: false })
    expect(ansi.split('\n')[0]).toBe('✖ NUXT_E1001 (500): The widget factory received an empty name.')

    expect(toMarkdown(report, { cwd: '/proj' })).toContain('## Error: NUXT_E1001\n')
  })
})

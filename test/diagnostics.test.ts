import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi, renderOverlay, renderPage, toMarkdown } from '../src'

const SOURCE = 'const props = defineProps()\nconst widget = useWidget()\nawait widget.load()\nexport {}\n'

const loaders = [{ name: 'memory', read: (file: string) => file === '/proj/pages/index.vue' ? SOURCE : undefined }]

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
    expect(report.frames[0]).toMatchObject({ file: '/proj/pages/index.vue', line: 2, column: 16, type: 'app' })
    expect(report.frames[0]!.snippet!.lines).toContain('const widget = useWidget()')
  })

  it('lists sources that do not resolve to a readable file', async () => {
    const report = await createReport(diagnostic({ sources: ['/proj/pages/gone.vue:2:1', 'somewhere in the build'] }), { cwd: '/proj', loaders })
    expect(report.frames.every(frame => frame.type !== 'app')).toBe(true)
    expect(report.sections.find(section => section.id === 'sources')).toEqual({
      id: 'sources',
      title: 'Sources',
      content: '/proj/pages/gone.vue:2:1\nsomewhere in the build',
    })
  })

  it('does not mark an ordinary coded error as a diagnostic', async () => {
    const report = await createReport(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }), { cwd: '/proj', loaders: [], snippets: false })
    expect(report.diagnostic).toBeUndefined()
    expect(report.hint).toBeUndefined()
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

import { describe, expect, it } from 'vitest'
import { createReport, injectOverlay, renderOverlay, renderPage, toMarkdown } from '../src'

async function report() {
  const error = Object.assign(new Error('Something <broke>'), { code: 'E1001' })
  error.stack = `Error: Something <broke>
    at handler (/proj/src/handler.ts:3:9)
    at dep (/proj/node_modules/dep/index.js:2:2)
    at node:internal/main:3:3`
  const r = await createReport(error, {
    cwd: '/proj',
    loaders: [{ name: 'memory', read: file => file === '/proj/src/handler.ts' ? 'const a = 1\nconst b = 2\nthrow new Error(`x` + a) // boom\nexport {}\n' : undefined }],
  })
  r.hint = 'Do the thing'
  r.docsUrl = 'https://example.com/e1001'
  r.trace = [{ label: '<App>', file: '/proj/app.vue' }, { label: '<Child>' }]
  r.sections.push({ id: 'request', title: 'Request', content: { method: 'GET', url: '/x' } })
  return r
}

/** Server-rendered markup only, without the embedded state and client script. */
function markup(html: string): string {
  return html.slice(0, html.indexOf('<script type="application/json">'))
}

describe('renderPage', () => {
  it('renders a full document with embedded state', async () => {
    const html = renderPage(await report(), { cwd: '/proj', channel: '/__my-bad', theme: { name: 'Nuxt', accent: '#00dc82', vars: { '--mb-bg': '#020420', 'bad;}': 'x' } } })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Something &lt;broke&gt;')
    expect(html).toContain('data-action="open" data-file="/proj/src/handler.ts" data-line="3" data-column="9"')
    expect(html).toContain('<span class="tk-keyword">throw</span>')
    expect(html).toContain(':root{--mb-accent:#00dc82;--mb-bg:#020420}')
    expect(html).toContain('2 dependency frames')
    expect(html).toMatch(/<script type="application\/json">\{"mode":"page"/)
    expect(html).toContain('data-action="logs"')
    expect(html).toContain('Request')
    expect(html).toContain('https://example.com/e1001')
    expect(html).not.toContain('</script><script>alert')
  })

  it('keeps embedded state parseable and free of script-breaking sequences', async () => {
    const r = await report()
    r.message = '</script><script>alert(1)</script> <!-- comment --> \u2028'
    const html = renderPage(r)
    const stateStart = html.indexOf('<script type="application/json">') + '<script type="application/json">'.length
    const state = html.slice(stateStart, html.indexOf('</script>', stateStart))
    expect(state).not.toMatch(/<(?:\/script|!--)/i)
    expect(JSON.parse(state).report.message).toBe(r.message)
  })

  it('omits live-only UI without a channel', async () => {
    const html = markup(renderPage(await report()))
    expect(html).not.toContain('data-action="logs"')
    expect(html).not.toContain('data-live')
  })
})

describe('renderOverlay', () => {
  it('renders a custom element with state and script', async () => {
    const html = renderOverlay(await report(), { startMinimized: true, tag: 'nuxt-error-overlay' })
    expect(html.startsWith('<nuxt-error-overlay></nuxt-error-overlay>')).toBe(true)
    expect(html).toContain('"mode":"overlay"')
    expect(html).toContain('"startMinimized":true')
    expect(html).toContain(':host{all:initial')
  })

  it('rejects invalid tag names', async () => {
    await expect(async () => renderOverlay(await report(), { tag: 'div' })).rejects.toThrow()
  })
})

describe('toMarkdown', () => {
  it('produces an issue-ready summary', async () => {
    expect(toMarkdown(await report(), { cwd: '/proj' })).toMatchInlineSnapshot(`
      "## Error: Error [E1001]

      \`\`\`
      Something <broke>
      \`\`\`

      > Do the thing

      Docs: https://example.com/e1001

      Component trace: \`<App>\` › \`<Child>\`

      \`./src/handler.ts:3:9\`

      \`\`\`ts
        1 | const a = 1
        2 | const b = 2
      > 3 | throw new Error(\`x\` + a) // boom
        4 | export {}
        5 | 
      \`\`\`

      \`\`\`
          at handler (./src/handler.ts:3:9)
          ... 2 more
      \`\`\`

      **Request**

      - method: \`GET\`
      - url: \`/x\`
      "
    `)
  })
})

describe('injectOverlay', () => {
  it('survives $-patterns that String.prototype.replace would interpret', async () => {
    const r = await report()
    const overlay = renderOverlay(r)
    expect(overlay).not.toMatch(/\$[&'`<\d]/)
    const html = injectOverlay('<html><body><p>page</p></body></html>', r)
    expect(html.endsWith('</script></body></html>')).toBe(true)
    expect(injectOverlay('<p>no body</p>', r).startsWith('<p>no body</p><my-bad-overlay>')).toBe(true)
  })
})

describe('determinism', () => {
  it('renders identical markup for the same report', async () => {
    const r = await report()
    r.causes.push({ ...r, id: 'cause', causes: [], errors: undefined })
    const a = renderPage(r, { cwd: '/proj' })
    renderPage(await report(), { cwd: '/proj' })
    const b = renderPage(r, { cwd: '/proj' })
    expect(a).toBe(b)
    expect(a).not.toMatch(/mb-r\d+/)
    const ids = [...markup(a).matchAll(/ id="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('aligns the caret under tab-indented code', async () => {
    const r = await report()
    r.frames[0]!.snippet = { start: 1, lines: ['\t\tthrow new Error()'], lang: 'ts' }
    r.frames[0]!.line = 1
    r.frames[0]!.column = 9
    const html = renderPage(r)
    expect(html).toContain('<span class="mb-src">\t\t      ^</span>')
  })
})

describe('in-memory compiled locations', () => {
  it('labels a compiled location that shares the source path', async () => {
    const r = await report()
    r.frames[0]!.compiled = { file: r.frames[0]!.file!, line: 9, column: 2, snippet: { start: 8, lines: ['a', 'b', 'c'] } }
    const html = markup(renderPage(r))
    expect(html).toContain('in memory')
    expect(html).toContain('data-snippet-compiled')
    r.frames[0]!.compiled = { file: '/proj/dist/handler.js', line: 9, column: 2 }
    expect(markup(renderPage(r))).not.toContain('in memory')
  })
})

describe('dependency paths', () => {
  it('shortens pnpm store paths to the package-relative part', async () => {
    const r = await report()
    r.frames[1]!.file = '/proj/node_modules/.pnpm/@vue+runtime-core@3.5.42_typescript@5.9.2/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js'
    const html = markup(renderPage(r, { cwd: '/proj' }))
    expect(html).toContain('…/@vue/runtime-core/dist/')
    expect(html).not.toContain('.pnpm/@vue+runtime-core@3.5.42_typescript@5.9.2/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:2')
    expect(html).toContain('title="/proj/node_modules/.pnpm/@vue+runtime-core@3.5.42_typescript@5.9.2/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js"')
  })
})

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
    expect(html).toContain('Show framework frames <span class="mb-count">(2)</span>')
    expect(html).toMatch(/<script type="application\/json">\{"mode":"page"/)
    expect(html).toContain('data-action="logs"')
    expect(html).toContain('Request')
    expect(html).toContain('https://example.com/e1001')
    expect(html).not.toContain('</script><script>alert')
  })

  it('uses my-bad by default and lets an integration layer its brand onto the same layout', async () => {
    const r = await report()
    const original = markup(renderPage(r))
    expect(original).toContain('<span class="mb-brand-name">my-bad</span>')
    expect(original).not.toContain('nuxt.com')
    const logo = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>'
    const branded = markup(renderPage(r, { theme: { name: 'Acme', logo, url: 'https://example.com', accent: '#00dc82', vars: { '--mb-font-display': 'serif' } } }))
    expect(branded).toContain(`${logo}<span class="mb-brand-name mb-sr-only">Acme</span>`)
    expect(branded).toContain('href="https://example.com"')
    expect(branded).toContain('--mb-accent:#00dc82;--mb-font-display:serif')
    for (const html of [original, branded]) {
      expect(html).toContain('aria-label="Error source"')
      expect(html).toContain('data-action="stack"')
      expect(html).toContain('Copy error')
    }
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

  it('labels a generated snippet when only a compiled position is known', async () => {
    const compiled = await createReport({
      name: 'RolldownError',
      message: 'Parse failed with 1 error:',
      id: '/proj/app.vue',
      loc: { file: '/proj/app.vue', line: 8, column: 39 },
      frame: '7  |      _createElementVNode("div", {\n8  |        class: _normalizeClass(_ctx.bob !)\n   |                                        ^',
    }, { cwd: '/proj', kind: 'compile', compiled: true, loaders: [], snippets: false })
    const markdown = toMarkdown(compiled, { cwd: '/proj' })
    expect(markdown).toContain('Generated code `./app.vue:8:39`')
    expect(markdown).toContain('> 8 |       class: _normalizeClass(_ctx.bob !)')
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
    expect(html).toContain('<span class="mb-caret" aria-hidden="true">\t\t      ^</span>')
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

describe('source-first presentation', () => {
  it('keeps the message as the heading and preserves every cause and related error', async () => {
    const r = await report()
    r.causes.push({ ...r, id: 'cause', message: 'Inner failure', causes: [], errors: undefined })
    r.errors = [{ ...r.causes[0]!, id: 'related', message: 'Independent failure' }]
    const html = markup(renderPage(r))
    expect(html).toMatch(/<h1[^>]*data-message>Something &lt;broke&gt;<\/h1>/)
    expect(html).toContain('data-action="cause" data-path="rc0"')
    expect(html).toContain('Inner failure')
    expect(html).toContain('data-action="cause" data-path="re0"')
    expect(html).toContain('Independent failure')
    expect(html).toContain('data-action="stack"')
    expect(html).toContain('Component trace')
    expect(toMarkdown(r)).toContain('Independent failure')
  })

  it('counts related errors in the header and marks warnings visibly', async () => {
    const r = await report()
    expect(markup(renderPage(r))).toContain('<span class="mb-header-count">1 error</span>')
    r.errors = [{ ...r, id: 'a', causes: [], errors: undefined }, { ...r, id: 'b', causes: [], errors: undefined }]
    expect(markup(renderPage(r))).toContain('<span class="mb-header-count">3 errors</span>')

    const warning = await report()
    warning.kind = 'warning'
    const html = markup(renderPage(warning))
    expect(html).toContain('<span class="mb-header-count">Warning</span>')
    expect(html).toContain('</svg>Warning</span>')
    expect(html).not.toContain('data-kind-label class="mb-sr-only"')
  })

  it('renders the source of every cause and related error without the client script', async () => {
    const r = await report()
    const cause = { ...r, id: 'cause', message: 'Inner failure', causes: [], errors: undefined, frames: [{ ...r.frames[0]!, file: '/proj/src/cause.ts' }] }
    r.causes.push(cause)
    r.errors = [{ ...cause, id: 'related', message: 'Independent failure' }]
    const html = markup(renderPage(r))
    const fallback = html.slice(html.indexOf('data-fallback'), html.indexOf('class="mb-secondary"'))
    expect(fallback).toContain('Inner failure')
    expect(fallback).toContain('Independent failure')
    expect(fallback.match(/data-file="\/proj\/src\/cause\.ts"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(fallback).not.toContain('data-action="cause"')
    expect(fallback).not.toContain('id="mb-copy-menu"')
    expect(fallback.match(/<h1/g)).toBe(null)
  })

  it('keeps request context in one place and groups missing framework code in stack order', async () => {
    const r = await report()
    r.frames.push({ type: 'app', function: 'caller', file: '/proj/caller.ts', line: 1, snippet: { start: 1, lines: ['handler()'] } }, { type: 'internal', function: 'runtime', file: 'node:runtime' })
    r.frames[1]!.snippet = undefined
    const html = markup(renderPage(r))
    expect(html.match(/data-action="info"/g)).toHaveLength(1)
    expect(html.slice(0, html.indexOf('</header>'))).not.toContain('data-action="info"')
    expect(html.match(/class="mb-framework-group"/g)).toHaveLength(2)
    expect(html).toContain('<span>2 – 3</span>')
    expect(html).toContain('Code not captured')
    expect(html.indexOf('<span>2 – 3</span>')).toBeLessThan(html.indexOf('title="caller"'))
    expect(html.indexOf('title="caller"')).toBeLessThan(html.indexOf('<span>5</span>'))
    expect(html).not.toContain('data-frame-toggle')
  })

  it('does not invent source when no stack was captured', async () => {
    const r = await createReport(new Error('No source'), { loaders: [], snippets: false })
    r.frames = []
    const html = markup(renderPage(r))
    expect(html).toContain('No stack trace was provided.')
    expect(html).not.toContain('data-frame ')
    expect(html).not.toContain('data-stack')
  })

  it.each(['app', 'vendor', 'internal'] as const)('does not offer an empty call stack for a single %s frame', async (type) => {
    const r = await report()
    r.frames = [{ ...r.frames[0]!, type }]
    const html = markup(renderPage(r))
    expect(html).toContain('data-frame ')
    expect(html).not.toContain('data-action="stack"')
    expect(html).not.toContain('data-action="framework"')
  })

  it('renders a compiled-only excerpt at its generated location', async () => {
    const r = await report()
    r.frames = [{ type: 'app', file: '/proj/app.vue', compiled: { file: '/proj/app.vue', line: 8, column: 3, snippet: { start: 8, lines: ['  invalid()'] } } }]
    const html = markup(renderPage(r, { cwd: '/proj' }))
    expect(html).toContain('data-compiled="true"')
    expect(html).toContain('data-snippet-compiled')
    expect(html).toContain('Source of app.vue, line 8 highlighted')
    expect(html).not.toContain('data-switch=')
    expect(html).not.toContain('data-action="open" data-file="/proj/app.vue" data-line="8"')
  })
})

import type { Browser } from 'playwright'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { clientAssets, createProblemReport, createReport, renderBadge, renderOverlay, renderPage } from '../src'
import { createChannel } from '../src/channel'
import { badgeState } from '../src/render/html'
import { assetUrls } from '../src/render/html/assets'
import { escapeScript } from '../src/render/html/escape'

let browser: Browser
let close: () => void
let origin: string
const proj = await realpath(await mkdtemp(join(tmpdir(), 'my-bad-proj-')))
await mkdir(join(proj, 'src'))
await writeFile(join(proj, 'src/handler.ts'), 'line1\nthrow new Error()\nline3\n')
await writeFile(join(proj, 'caller.ts'), 'start()\nhandler()\nfinish()\n')

const openRequests: unknown[] = []
const channel = createChannel({
  open: request => void openRequests.push(request),
  root: proj,
})
const assets = { script: '/client.js', styles: '/client.css' }
const CSP_NONCE = 'n0nce+/='

async function waitFor<T>(fn: () => Promise<T> | T, expected: T, timeout = 5000): Promise<void> {
  const start = Date.now()
  let last: T
  do {
    last = await fn()
    if (last === expected) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() - start < timeout)
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}, last value ${JSON.stringify(last)}`)
}

/** Stands in for the Vite DevTools client: runs the dock's client script against a recording context. */
const devtoolsHost = `
const calls = { switched: [], badges: [], messages: {}, added: [], removed: [] }
const entryMeta = { id: 'my-bad', type: 'iframe', title: 'my-bad', icon: 'ph:bug', url: '/__my-bad/panel?embed' }
const listeners = []
const ctx = {
  current: { entryMeta, domElements: { get iframe() { return document.querySelector('iframe') } } },
  panel: { session: { open: false } },
  docks: {
    async switchEntry(id) {
      calls.switched.push(id)
      if (!document.querySelector('iframe')) {
        const iframe = document.createElement('iframe')
        iframe.src = entryMeta.url
        iframe.style.cssText = 'width:1000px;height:600px'
        document.body.append(iframe)
      }
      return true
    },
    register: () => ({ update: patch => calls.badges.push(patch) }),
  },
  messages: {
    async add(input) { calls.messages[input.id] = input; calls.added.push(input.id) },
    async remove(id) { delete calls.messages[id]; calls.removed.push(id) },
  },
  rpc: { sharedState: { async get() { return { on: (_, listener) => listeners.push(listener) } } } },
}
window.devtools = { calls, activate: params => listeners.forEach(listener => listener({ activation: { dockId: 'my-bad', params } })) }
const { default: setup } = await import(${JSON.stringify(assetUrls('/__my-bad').devtools)})
`

async function report(message: string) {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at handler (${proj}/src/handler.ts:2:3)\n    at dep (${proj}/node_modules/dep/index.js:1:1)`
  return createReport(error, {
    cwd: proj,
    loaders: [
      {
        name: 'memory',
        read: () => 'line1\nthrow new Error()\nline3\n',
      },
    ],
  })
}

beforeAll(async () => {
  browser = await chromium.launch()
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/__csp-channel/')) {
      res.setHeader('content-security-policy', `script-src 'nonce-${CSP_NONCE}'; style-src 'nonce-${CSP_NONCE}'`)
      if (await channel.handler(req, res, { nonce: CSP_NONCE })) {
        return
      }
    }
    if (await channel.handler(req, res)) {
      return
    }
    if (req.url === '/client.js' || req.url === '/client.css') {
      res.setHeader('content-type', req.url.endsWith('.js')
        ? 'text/javascript'
        : 'text/css')
      res.end(req.url.endsWith('.js')
        ? clientAssets.script
        : clientAssets.styles)
      return
    }
    if (req.url === '/badge.js') {
      res.setHeader('content-type', 'text/javascript')
      res.end(clientAssets.badge)
      return
    }
    if (req.url === '/devtools-panel') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><body><div id="host" class="devframes-color-root dark" style="--devframe-primary-DEFAULT:#ff7a00"><div style="background:rgba(17, 17, 17, 0.8);color:rgb(244, 244, 245);font-family:Georgia"><iframe src="/__my-bad/panel?embed" style="width:900px;height:600px"></iframe></div></div></body></html>`)
      return
    }
    if (req.url === '/devtools-panel-themed') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><head>${renderBadge({
        cwd: proj,
        channel: '/__my-bad',
        theme: { accent: '#00ff00', css: '.mb-root{font-family:monospace!important}' },
      })}</head><body><div class="devframes-color-root dark"><div style="background:#111;color:#eee;font-family:Georgia"><iframe src="/__my-bad/panel?embed"></iframe></div></div></body></html>`)
      return
    }
    if (req.url === '/devtools-host') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><head>${renderBadge({ cwd: proj, channel: '/__my-bad' })}</head><body><h1 id="user">User page</h1><script type="module">${devtoolsHost}await setup(ctx)</script></body></html>`)
      return
    }
    if (req.url === '/devtools-host-bare') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User page</h1><script type="module">${devtoolsHost}await setup(ctx, { badge: ${escapeScript(JSON.stringify(badgeState({ cwd: proj, channel: '/__my-bad' })))} })</script></body></html>`)
      return
    }
    if (req.url === '/nested/badge-relative') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><head>${renderBadge({ cwd: proj, channel: '../__my-bad' })}</head><body><h1 id="user">User page</h1></body></html>`)
      return
    }
    if (req.url === '/badge-await' || req.url === '/badge-await-long') {
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><head>${renderBadge({
        cwd: proj,
        channel: '/__my-bad',
        awaitHost: req.url === '/badge-await'
          ? 1500
          : 60_000,
      })}</head><body><h1 id="user">User page</h1></body></html>`)
      return
    }
    if (req.url?.startsWith('/badge')) {
      const variant = req.url.slice('/badge'.length)
      const tag = variant === '-tagged'
        ? 'nuxt-error-overlay'
        : undefined
      const badge = renderBadge({
        cwd: proj,
        channel: '/__my-bad',
        tag,
        assets: variant === '-external'
          ? { ...assets, badge: '/badge.js' }
          : undefined,
      })
      const overlay = variant.startsWith('-overlay')
        ? renderOverlay(channel.current ?? await report('initial'), { cwd: proj, channel: '/__my-bad', assets })
        : ''
      const last = variant === '-overlay-first'
      res.setHeader('content-type', 'text/html')
      res.end(`<!DOCTYPE html><html><head>${last ? '' : badge}</head><body><h1 id="user">User page</h1>${overlay}${last ? badge : ''}</body></html>`)
      return
    }
    const current = channel.current ?? await report('initial')
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/csp-')) {
      const url = new URL(req.url, origin)
      const nonce = url.searchParams.has('nonce')
        ? CSP_NONCE
        : undefined
      res.setHeader('content-security-policy', `script-src 'nonce-${CSP_NONCE}'; style-src 'nonce-${CSP_NONCE}'`)
      if (url.pathname === '/csp-page') {
        res.end(renderPage(current, { cwd: proj, channel: '/__my-bad', nonce }))
      }
      else if (url.pathname === '/csp-overlay') {
        res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: proj, channel: '/__my-bad', nonce })}</body></html>`)
      }
      else if (url.pathname === '/csp-drawer') {
        res.end(`<!DOCTYPE html><html><head>${renderBadge({
          cwd: proj,
          channel: '/__csp-channel',
          nonce,
          theme: {
            vars: { '--mb-csp': 'adopted' },
          },
        })}</head><body><h1 id="user">User page</h1></body></html>`)
      }
      else if (url.pathname === '/csp-devtools') {
        const attr = nonce
          ? ` nonce="${nonce}"`
          : ''
        res.end(`<!DOCTYPE html><html><head><meta property="csp-nonce"${attr}></head><body><h1 id="user">User page</h1><script type="module"${attr}>${devtoolsHost}await setup(ctx, { badge: ${escapeScript(JSON.stringify(badgeState({ cwd: proj, channel: '/__my-bad' })))} })</script></body></html>`)
      }
      else {
        res.end(`<!DOCTYPE html><html><head>${renderBadge({ cwd: proj, channel: '/__my-bad', nonce })}</head><body><h1 id="user">User page</h1></body></html>`)
      }
      return
    }
    if (req.url === '/overlay-external') {
      res.end(`<!DOCTYPE html><html><body>${renderOverlay(current, { cwd: proj, assets })}</body></html>`)
      return
    }
    if (req.url === '/page-external') {
      res.end(renderPage(current, { cwd: proj, assets }))
      return
    }
    if (req.url === '/blank') {
      res.end('<!DOCTYPE html><html><body><h1 id="user">User error page</h1></body></html>')
      return
    }
    if (req.url === '/fragment-external') {
      res.setHeader('content-type', 'text/plain')
      res.end(renderOverlay(current, { cwd: proj, assets }))
      return
    }
    if (req.url === '/overlay-minimized') {
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: proj, channel: '/__my-bad', startMinimized: true })}</body></html>`)
      return
    }
    if (req.url?.startsWith('/scoped')) {
      const requestId = new URL(req.url, origin).searchParams.get('rid') ?? undefined
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: proj, channel: '/__my-bad', requestId })}</body></html>`)
      return
    }
    if (req.url === '/overlay-tagged') {
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: proj, channel: '/__my-bad', tag: 'nuxt-error-overlay' })}</body></html>`)
      return
    }
    if (req.url === '/overlay') {
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: proj, channel: '/__my-bad' })}</body></html>`)
      return
    }
    res.end(renderPage(current, { cwd: proj, channel: '/__my-bad', history: channel.history }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  close = () => {
    channel.close()
    server.close()
  }
}, 30_000)

afterAll(async () => {
  await browser.close()
  close()
})

describe('browser client', () => {
  it('hydrates, connects, re-renders on error:set and shows warnings and logs', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    await waitFor(() => page.locator('[data-live][data-connected]').count(), 1)
    expect(await page.locator('[data-message]').first().textContent()).toBe('initial')
    expect(await page.locator('[data-active]').count()).toBe(1)

    channel.setError(await report('second'))
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'second')

    channel.warn({
      ...(await report('careful')),
      kind: 'warning',
    })
    await waitFor(() => page.locator('[data-toast]').count(), 1)
    expect(await page.locator('[data-warning-count]').textContent()).toBe('1 warning')

    channel.progress({ phase: 'build', percent: 40, message: 'Building server' })
    await waitFor(() => page.locator('[data-progress]:not([hidden])').count(), 1)
    expect(await page.locator('[data-progress-label]').textContent()).toBe('Building server')
    expect(await page.locator('[data-progress]').getAttribute('aria-valuenow')).toBe('40')
    channel.progress({ phase: 'done', percent: 100 })
    await waitFor(() => page.locator('[data-progress][hidden]').count(), 1)

    channel.log({ level: 'warn', text: 'something happened' })
    await waitFor(() => page.locator('[data-log-count]').textContent(), '1')
    await page.click('[data-action="logs"]')
    expect(await page.locator('[data-log]').textContent()).toContain('something happened')

    await page.click('[data-action="theme"]')
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

    await page.getByRole('button', { name: 'Close server logs', exact: true }).click()
    channel.log({ level: 'info', text: 'unread' })
    await waitFor(() => page.locator('[data-log-count]').textContent(), '1')
    channel.setError(await report('third'))
    await waitFor(() => page.locator('.mb-message').first().textContent(), 'third')
    expect(await page.locator('[data-warning-count]').textContent()).toBe('1 warning')
    expect(await page.locator('[data-log-count]').textContent()).toBe('1')
    expect(await page.locator('.mb-toast').count()).toBe(1)

    await page.click('[data-toast] [data-action="show-toast"]')
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'careful')
    expect(await page.locator('[data-kind-label]').first().textContent()).toContain('Warning')

    await page.click('[data-action="history"][data-dir="-1"]')
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'second')

    const reloaded = page.waitForNavigation()
    channel.clearError()
    await reloaded
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('counts warnings already published and drops retired ones', async () => {
    channel.clearWarning()
    channel.setError(await report('with warnings'))
    const earlier = {
      ...(await report('earlier warning')),
      kind: 'warning' as const,
    }
    channel.warn(earlier)
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(origin)
    const count = page.locator('[data-warning-count]')
    expect(await count.textContent()).toBe('1 warning')
    await waitFor(() => page.locator('[data-live][data-connected]').count(), 1)

    const later = {
      ...(await report('later warning')),
      kind: 'warning' as const,
    }
    channel.warn(later)
    await waitFor(() => count.textContent(), '2 warnings')
    await page.click('[data-toast] [data-action="show-toast"]')
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'later warning')

    channel.clearWarning(later.id)
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'with warnings')
    await waitFor(() => count.textContent(), '1 warning')
    expect(await page.locator('[data-toast]').count()).toBe(0)

    channel.clearWarning(earlier.id)
    await waitFor(() => count.isVisible(), false)
    await page.close()
  }, 30_000)

  it('shows the build progress label below the bar, clear of the header', async () => {
    for (const path of ['/', '/overlay']) {
      channel.setError(await report(`progress ${path}`))
      const page = await browser.newPage({
        viewport: { width: 1200, height: 760 },
      })
      await page.goto(`${origin}${path}`)
      await waitFor(() => page.locator('[data-message]').first().textContent(), `progress ${path}`)
      channel.progress({ phase: 'build', percent: 40, message: 'Building server' })
      await waitFor(() => page.locator('[data-progress]:not([hidden])').count(), 1)

      const bar = (await page.locator('[data-progress]').boundingBox())!
      const label = (await page.locator('[data-progress-label]').boundingBox())!
      const header = (await page.locator('.mb-header').boundingBox())!
      const tools = (await page.locator('.mb-tools').boundingBox())!
      const brand = (await page.locator('.mb-brand').boundingBox())!

      expect(bar.y + bar.height, path).toBeCloseTo(header.y + header.height, 0)
      expect(label.y, path).toBeGreaterThanOrEqual(bar.y + bar.height)
      for (const other of [tools, brand]) {
        expect(label.y >= other.y + other.height || label.x >= other.x + other.width || other.x >= label.x + label.width, path).toBe(true)
      }

      channel.progress({ phase: 'done', percent: 100 })
      await waitFor(() => page.locator('[data-progress][hidden]').count(), 1)
      await page.close()
    }
  }, 30_000)

  it('mounts the overlay in a shadow root and minimises', async () => {
    channel.setError(await report('overlay'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/overlay`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'overlay')
    expect(await page.locator('#user').isVisible()).toBe(true)
    const preview = overlay.locator('[data-preview]')
    await waitFor(() => preview.isVisible(), true)
    const snapshot = await preview.locator('iframe').getAttribute('srcdoc')
    expect(snapshot).toContain('User error page')
    expect(snapshot).not.toContain('<script')
    expect(snapshot).not.toContain('my-bad-overlay')
    await preview.locator('[data-action="minimize"]').click()
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), '')
    await waitFor(() => preview.isVisible(), false)
    await overlay.locator('[data-overlay]').click({
      position: { x: 60, y: 60 },
    })
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), null)
    await waitFor(() => preview.isVisible(), true)
    await preview.hover()
    await preview.locator('[data-action="hide-preview"]').click()
    await waitFor(() => preview.isVisible(), false)
    expect(await page.evaluate(() => localStorage.getItem('my-bad:overlay:preview-hidden'))).toBeNull()
    channel.setError(await report('overlay again'))
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'overlay again')
    await waitFor(() => preview.isVisible(), true)
    await preview.locator('[data-action="minimize"]').click()
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), '')
    expect(await page.evaluate(() => localStorage.getItem('my-bad:overlay:minimized'))).toBe('1')
    await overlay.locator('[data-overlay]').click({
      position: { x: 60, y: 60 },
    })
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), null)
    await preview.locator('[data-action="minimize"]').click()
    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => overlay.locator('[data-action="restore"]').isVisible(), true)
    expect(await page.evaluate(() => localStorage.getItem('my-bad:overlay:hidden'))).toBeNull()
    expect(await page.evaluate(key => sessionStorage.getItem(key), `my-bad:overlay:hidden:${proj}`)).toBe('1')
    channel.clearError()
    await waitFor(() => page.locator('my-bad-overlay').count(), 0)
    await page.close()
  }, 30_000)

  it('renders left to right inside a right-to-left page', async () => {
    channel.clearError()
    const page = await browser.newPage()
    await page.goto(`${origin}/overlay`)
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'))
    channel.setError(await report('rtl page.'))
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'rtl page.')
    const measured = await overlay.locator('[data-message]').first().evaluate((el) => {
      const node = el.firstChild as Text
      const text = node.textContent ?? ''
      const first = text.search(/\S/)
      const range = document.createRange()
      range.setStart(node, first)
      range.setEnd(node, first + 1)
      const startX = range.getBoundingClientRect().x
      range.setStart(node, text.length - 1)
      range.setEnd(node, text.length)
      return { direction: getComputedStyle(el).direction, startX, endX: range.getBoundingClientRect().x }
    })
    expect(measured.direction).toBe('ltr')
    expect(measured.endX).toBeGreaterThan(measured.startX)
    await page.close()
  }, 30_000)

  it('keeps warning toasts clear of the page preview', async () => {
    for (const [width, dock] of [
      [1200, 'bottom-right'],
      [500, 'bottom-right'],
      [500, 'bottom-left'],
    ] as const) {
      channel.clearWarning()
      channel.setError(await report(`preview ${width} ${dock}`))
      const page = await browser.newPage({
        viewport: { width, height: 800 },
      })
      await page.goto(`${origin}/blank`)
      await page.evaluate(dock => localStorage.setItem('my-bad:overlay:dock', dock), dock)
      await page.goto(`${origin}/overlay`)
      const overlay = page.locator('my-bad-overlay')
      await waitFor(() => overlay.locator('[data-preview]').isVisible(), true)
      await waitFor(() => overlay.locator('[data-live][data-connected]').count(), 1)
      channel.warn({
        ...(await report('under the preview')),
        kind: 'warning',
      })
      await waitFor(() => overlay.locator('[data-toast]').count(), 1)
      const hit = await page.evaluate(() => {
        const shadow = document.querySelector('my-bad-overlay')!.shadowRoot!
        const rect = shadow.querySelector('[data-toast] [data-action="show-toast"]')!.getBoundingClientRect()
        return shadow.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('[data-toast]')
          ? 'toast'
          : shadow.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.className
      })
      expect(hit, `${width} ${dock}`).toBe('toast')
      await page.close()
    }
    channel.clearWarning()
  }, 30_000)

  it('ignores an error from another request and follows its own', async () => {
    channel.setError(await report('scoped start'))
    const pages = await Promise.all(['a', 'b'].map(async (id) => {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      })
      await page.goto(`${origin}/scoped?rid=${id}`)
      await waitFor(() => page.locator('my-bad-overlay').locator('[data-message]').first().textContent(), 'scoped start')
      return page
    }))
    const [a, b] = pages as [typeof pages[0], typeof pages[0]]

    const forA = await report('only for a')
    channel.setError(forA, 'a', 'GET /scoped?rid=a')
    await waitFor(() => a.locator('my-bad-overlay').locator('[data-message]').first().textContent(), 'only for a')
    expect(await b.locator('my-bad-overlay').locator('[data-message]').first().textContent()).toBe('scoped start')
    await waitFor(async () => (await b.locator('my-bad-overlay').locator('[data-pager-label]').textContent())?.endsWith(`of ${channel.history.length}`), true)

    channel.clearError(forA.id)
    await waitFor(() => a.locator('my-bad-overlay').locator('[data-message]').first().textContent(), 'scoped start')
    expect(await b.locator('my-bad-overlay').locator('[data-message]').first().textContent()).toBe('scoped start')

    const forB = await report('only for b')
    channel.setError(forB, 'b', 'GET /scoped?rid=b')
    await waitFor(() => b.locator('my-bad-overlay').locator('[data-message]').first().textContent(), 'only for b')
    channel.clearError()
    for (const page of pages) {
      await waitFor(() => page.locator('my-bad-overlay').count(), 0)
    }

    channel.setError(await report('for everyone'))
    for (const page of pages) {
      await waitFor(() => page.locator('my-bad-overlay').locator('[data-message]').first().textContent(), 'for everyone')
      await page.close()
    }
  }, 30_000)

  it('lists the history the channel sends in the History menu, and keeps it current while open', async () => {
    channel.setError(await report('listed first'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/scoped?rid=a`)
    const menu = page.locator('my-bad-overlay').locator('.mb-history')
    await waitFor(() => menu.locator('li').count(), channel.history.length)
    await menu.locator('summary').click()
    const [retired, focused] = await Promise.all(['listed later', 'kept focused'].map(async message => ({
      ...(await report(message)),
      kind: 'warning' as const,
    })))
    channel.warn(retired!)
    channel.warn(focused!)
    await waitFor(() => menu.locator('li').last().textContent(), 'kept focused')
    const button = menu.getByRole('button', { name: 'kept focused', exact: true })
    await button.focus()
    channel.clearWarning(retired!.id)
    await waitFor(() => menu.getByRole('button', { name: 'listed later', exact: true }).count(), 0)
    expect(await button.evaluate(element => element.matches(':focus'))).toBe(true)
    expect(await menu.getAttribute('open')).toBe('')
    channel.clearWarning()
    await waitFor(() => button.count(), 0)
    channel.clearError()
    await page.close()
  }, 30_000)

  it('can still be restored after its error clears and the next open error takes its place', async () => {
    channel.setError(await report('for every page'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/scoped?rid=a`)
    const overlay = page.locator('my-bad-overlay')
    const message = () => overlay.locator('[data-message]').first().textContent()
    await waitFor(message, 'for every page')
    const own = await report('only for this page')
    channel.setError(own, 'a', 'GET /scoped?rid=a')
    await waitFor(message, 'only for this page')

    channel.clearError(own.id)
    await waitFor(message, 'for every page')
    await page.keyboard.press('Escape')
    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => overlay.locator('[data-action="restore"]').isVisible(), true)
    await overlay.locator('[data-action="restore"]').click()
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-hidden'), null)
    channel.clearError()
    await page.close()
  }, 30_000)

  it('names its request when fetching a report from the history pager', async () => {
    channel.setError(await report('first of two'))
    channel.setError(await report('second of two'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/scoped?rid=a`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'second of two')
    channel.setError(await report('for someone else'), 'zzz', 'GET /elsewhere')
    await waitFor(() => overlay.locator('[data-pager-label]').count(), 1)

    const request = page.waitForRequest(candidate => candidate.url().includes('/__my-bad/history/'))
    await overlay.locator('[data-pager] [data-action="history"][data-dir="-1"]').click()
    const params = new URL((await request).url()).searchParams
    expect(params.get('requestId')).toBe('a')
    expect(params.get('path')).toBe('/scoped?rid=a')
    await page.close()
  }, 30_000)

  it('builds a new overlay for an error arriving after a clear', async () => {
    channel.setError(await report('before the clear'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/overlay-tagged`)
    const overlay = page.locator('nuxt-error-overlay')
    const message = () => overlay.locator('[data-message]').first().textContent()
    await waitFor(message, 'before the clear')

    channel.clearError()
    await waitFor(() => overlay.count(), 0)
    channel.setError(await report('after the clear'))
    await waitFor(message, 'after the clear')
    expect(await overlay.count()).toBe(1)
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    expect(await overlay.locator('[data-overlay]').isVisible()).toBe(true)

    channel.clearError()
    channel.clearError()
    channel.setError(await report('cleared and replaced at once'))
    await waitFor(message, 'cleared and replaced at once')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await overlay.count()).toBe(1)
    expect(await message()).toBe('cleared and replaced at once')
    await page.close()
  }, 30_000)

  it('keeps a startMinimized overlay minimised whatever the user last chose', async () => {
    channel.setError(await report('always minimized'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/blank`)
    await page.evaluate(() => localStorage.setItem('my-bad:overlay:minimized', '0'))
    await page.goto(`${origin}/overlay-minimized`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'always minimized')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBe('')
    expect(await page.evaluate(() => localStorage.getItem('my-bad:overlay:minimized'))).toBe('0')
    await overlay.locator('[data-action="expand"]').click()
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), null)
    await page.close()
  }, 30_000)

  it('mounts minimised when the user last minimised an overlay, and stays minimised on a new error', async () => {
    channel.setError(await report('remembered'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/blank`)
    await page.evaluate(() => localStorage.setItem('my-bad:overlay:minimized', '1'))
    await page.goto(`${origin}/overlay`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'remembered')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBe('')

    channel.setError(await report('arrived while minimised'))
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'arrived while minimised')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBe('')
    await page.close()
  }, 30_000)

  it('starts expanded again for a report the user expanded, and forgets it once minimised', async () => {
    channel.clearWarning()
    channel.setError(await report('expanded before the reload'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/overlay-minimized`)
    const overlay = page.locator('my-bad-overlay')
    const dialog = overlay.locator('[data-overlay]')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'expanded before the reload')
    expect(await dialog.getAttribute('data-minimized')).toBe('')

    await overlay.locator('[data-action="expand"]').click()
    await waitFor(() => dialog.getAttribute('data-minimized'), null)

    await page.reload()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'expanded before the reload')
    expect(await dialog.getAttribute('data-minimized')).toBeNull()

    channel.setError(await report('a different error'))
    await page.reload()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'a different error')
    expect(await dialog.getAttribute('data-minimized')).toBe('')

    await overlay.locator('[data-action="expand"]').click()
    await waitFor(() => dialog.getAttribute('data-minimized'), null)
    await overlay.locator('[data-preview] [data-action="minimize"]').click()
    await waitFor(() => dialog.getAttribute('data-minimized'), '')

    await page.reload()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'a different error')
    expect(await dialog.getAttribute('data-minimized')).toBe('')
    await page.close()
  }, 30_000)

  it('mounts and styles itself when the script and stylesheet are served separately', async () => {
    channel.setError(await report('external'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))

    await page.goto(`${origin}/page-external`)
    expect(await page.locator('[data-message]').first().textContent()).toBe('external')
    expect(await page.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')

    await page.goto(`${origin}/overlay-external`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'external')
    expect(await overlay.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')

    // The Vite client appends the overlay markup node by node, so the script is
    // DOM-inserted rather than parsed with the document.
    await page.goto(`${origin}/blank`)
    await page.evaluate(async () => {
      const html = await fetch('/fragment-external').then(res => res.text())
      const template = document.createElement('template')
      template.innerHTML = html
      for (const node of [...template.content.children]) {
        if (node.tagName === 'SCRIPT') {
          const script = document.createElement('script')
          for (const attr of node.attributes) {
            script.setAttribute(attr.name, attr.value)
          }
          script.textContent = node.textContent
          document.body.append(script)
        }
        else {
          document.body.append(node)
        }
      }
    })
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'external')
    expect(await overlay.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)
})

describe('badge', () => {
  async function warning(message: string) {
    return {
      ...(await report(message)),
      kind: 'warning' as const,
    }
  }

  /** Counts the event streams a page opens and closes. */
  async function open(path: string, prepare?: (page: import('playwright').Page) => Promise<void>) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await prepare?.(page)
    await page.addInitScript(() => {
      const streams = { opened: 0, closed: 0 }
      Object.assign(window, { streams })
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          streams.opened++
        }

        override close() {
          streams.closed++
          super.close()
        }
      }
    })
    await page.goto(`${origin}${path}`)
    const streams = () => page.evaluate(() => (window as unknown as { streams: { opened: number, closed: number } }).streams)
    await waitFor(async () => (await streams()).opened, 1)
    return { page, errors, streams }
  }

  function setHidden(page: import('playwright').Page, hidden: boolean) {
    return page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  }

  it('renders nothing until a warning arrives, then shows and retires it', async () => {
    channel.clearWarning()
    channel.clearError()
    const { page, errors } = await open('/badge-external')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    await waitFor(() => page.evaluate(() => document.body.childElementCount), 1)
    expect(await page.locator('my-bad-overlay-badge').count()).toBe(0)

    const careful = await warning('careful now')
    channel.warn(careful)
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.textContent()).toBe('Error: careful nowsrc/handler.ts:2')
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('1 warning')
    expect(await badge.getAttribute('title')).toBe('Show 1 warning')
    await waitFor(() => page.locator('my-bad-overlay-badge [role="status"]').textContent(), 'Warning: Error: careful now')

    channel.clearWarning(careful.id)
    await waitFor(() => peek.isVisible(), false)
    expect(await badge.isVisible()).toBe(false)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('counts warnings published before the page loaded and expands into the overlay over its own stream', async () => {
    channel.clearWarning()
    channel.clearError()
    const first = await warning('first warning')
    channel.warn(first)
    const { page, errors, streams } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => badge.isVisible(), true)
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('1 warning')
    expect(await page.locator('my-bad-overlay-badge .mb-peek').isVisible()).toBe(false)

    await badge.click()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'first warning')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBeNull()
    expect(await overlay.locator('[data-live][data-connected]').count()).toBe(1)
    await waitFor(() => badge.isVisible(), false)

    const second = await warning('second warning')
    channel.warn(second)
    await waitFor(() => overlay.locator('[data-warning-count]').textContent(), '2 warnings')
    expect(await overlay.locator('[data-toast]').count()).toBe(1)

    await page.keyboard.press('Escape')
    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => badge.isVisible(), true)
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('2 warnings')

    await badge.click()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'second warning')
    expect(await page.locator('script[src^="/__my-bad/client.js?v="]').count()).toBe(1)
    expect(await overlay.count()).toBe(1)

    channel.clearWarning()
    await waitFor(() => overlay.count(), 0)
    expect(await badge.isVisible()).toBe(false)
    expect(await streams()).toEqual({ opened: 1, closed: 0 })
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('opens warnings beside the page, without taking it over, until an error arrives', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.warn(await warning('only a warning'))
    const { page, errors } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const overlay = page.locator('my-bad-overlay')
    const dialog = overlay.locator('[data-overlay]')
    await waitFor(() => badge.isVisible(), true)
    await badge.click()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'only a warning')
    await waitFor(() => dialog.getAttribute('data-minimized'), null)

    const blocked = () => page.evaluate(() => ({
      inert: document.querySelector('#user')!.hasAttribute('inert'),
      overflow: document.documentElement.style.overflow,
    }))
    expect(await dialog.getAttribute('aria-modal')).toBe('false')
    expect(await dialog.getAttribute('aria-label')).toBe('Warning details')
    expect(await blocked()).toEqual({ inert: false, overflow: '' })
    expect(await overlay.locator('[data-preview]').isVisible()).toBe(false)
    expect(await page.evaluate(() => document.elementFromPoint(40, 40)?.id)).toBe('user')
    const names = () => overlay.locator('button:visible, [role="group"], nav, section, [data-overlay]').evaluateAll(elements => elements.map(el => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.localName === 'button'
      ? el.textContent
      : ''}`))
    expect((await names()).filter(name => /error|behind/i.test(name))).toEqual([])
    for (const action of ['hide', 'expand']) {
      expect(await overlay.locator(`.mb-pip-button[data-action="${action}"]`).getAttribute('aria-label')).not.toMatch(/error/i)
    }

    channel.setError(await report('now it is broken'))
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'now it is broken')
    await waitFor(() => dialog.getAttribute('aria-modal'), 'true')
    expect(await blocked()).toEqual({ inert: true, overflow: 'hidden' })
    expect(await overlay.locator('[data-preview] [data-action="minimize"]').getAttribute('aria-label')).toBe('Show page behind this error')
    expect(await overlay.locator('.mb-pip-button[data-action="hide"]').getAttribute('aria-label')).toBe('Hide error overlay')
    expect(await overlay.locator('[data-copy="markdown"]').first().textContent()).toBe('Copy error')

    channel.clearError()
    await waitFor(() => overlay.count(), 0)
    expect(await blocked()).toEqual({ inert: false, overflow: '' })
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('moves on to the next warning when the one on screen is fixed, and dismisses once none remain', async () => {
    channel.clearWarning()
    channel.clearError()
    const published = await Promise.all([1, 2, 3, 4, 5].map(index => warning(`warning ${index}`)))
    for (const entry of published) {
      channel.warn(entry)
    }
    const { page, errors } = await open('/badge-tagged')
    const badge = page.locator('nuxt-error-overlay-badge .mb-badge')
    const overlay = page.locator('nuxt-error-overlay')
    const message = () => overlay.locator('[data-message]').first().textContent()
    await waitFor(() => badge.isVisible(), true)
    await badge.click()
    await waitFor(message, 'warning 5')

    channel.clearWarning(published[4]!.id)
    await waitFor(message, 'warning 4')
    await waitFor(() => overlay.locator('[data-warning-count]').textContent(), '4 warnings')
    await waitFor(() => overlay.locator('[data-announce]').textContent(), 'Warning fixed. Next, Warning: Error: warning 4')

    await overlay.locator('.mb-pager [data-action="history"][data-dir="-1"]').click()
    await waitFor(message, 'warning 3')
    await page.locator('#user').click({
      position: { x: 10, y: 10 },
    })
    channel.clearWarning(published[2]!.id)
    await waitFor(message, 'warning 4')
    expect(await page.evaluate(() => document.activeElement?.localName)).toBe('body')

    for (const entry of published.slice(0, 2)) {
      channel.clearWarning(entry.id)
    }
    await page.waitForTimeout(300)
    expect(await message()).toBe('warning 4')
    channel.clearWarning(published[3]!.id)
    await waitFor(() => overlay.count(), 0)
    expect(await badge.isVisible()).toBe(false)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('skips a next warning that is retired while it loads', async () => {
    channel.clearWarning()
    channel.clearError()
    const published = await Promise.all([1, 2, 3].map(index => warning(`loading ${index}`)))
    for (const entry of published) {
      channel.warn(entry)
    }
    const { page, errors } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const overlay = page.locator('my-bad-overlay')
    const message = () => overlay.locator('[data-message]').first().textContent()
    await waitFor(() => badge.isVisible(), true)
    await badge.click()
    await waitFor(message, 'loading 3')

    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const requested: string[] = []
    await page.route(`${origin}/__my-bad/history/*`, async (route) => {
      requested.push(new URL(route.request().url()).pathname)
      await held
      await route.continue()
    })
    channel.clearWarning(published[2]!.id)
    await waitFor(() => requested.length, 1)
    channel.clearWarning(published[1]!.id)
    await waitFor(() => overlay.locator('[data-warning-count]').textContent(), '1 warning')
    release()
    await waitFor(message, 'loading 1')

    channel.clearWarning()
    await waitFor(() => overlay.count(), 0)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('does not announce a warning republished under an id it already counts', async () => {
    channel.clearWarning()
    channel.clearError()
    const { page, errors } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const status = page.locator('my-bad-overlay-badge [role="status"]')
    const careful = await warning('careful')
    channel.warn(careful)
    await waitFor(() => status.textContent(), 'Warning: Error: careful')
    await status.evaluate(el => (el.textContent = ''))
    channel.warn({ ...careful, message: 'careful, moved' })
    await page.waitForTimeout(300)
    expect(await status.textContent()).toBe('')
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('1 warning')

    channel.setError(await report('with a toast'))
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'with a toast')
    await overlay.locator('[data-action="expand"]').click()
    const other = await warning('another')
    channel.warn(other)
    await waitFor(() => overlay.locator('[data-toast]').count(), 1)
    await overlay.locator('[data-toast] [data-action="dismiss-toast"]').click()
    channel.warn({ ...other, message: 'another, moved' })
    channel.warn(careful)
    await page.waitForTimeout(300)
    expect(await overlay.locator('[data-toast]').count()).toBe(0)
    expect(await overlay.locator('[data-warning-count]').textContent()).toBe('2 warnings')

    await overlay.locator('.mb-pager [data-action="history"][data-dir="1"]').click()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'another, moved')
    channel.warn({ ...other, message: 'another, moved again' })
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'another, moved again')
    expect(await overlay.locator('[data-toast]').count()).toBe(0)
    channel.clearError()
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('mounts the overlay minimised for an error, stands in for it while hidden, and returns when the error clears', async () => {
    channel.clearWarning()
    channel.clearError()
    const { page, errors, streams } = await open('/badge-tagged')
    await page.evaluate(() => addEventListener('my-bad:error:clear', event => ((window as unknown as { cleared: unknown[] }).cleared ??= []).push((event as CustomEvent).detail.id)))
    const badge = page.locator('nuxt-error-overlay-badge .mb-badge')
    const overlay = page.locator('nuxt-error-overlay')
    channel.warn(await warning('beside the error'))
    await waitFor(() => page.locator('nuxt-error-overlay-badge .mb-dock').isVisible(), true)

    const broken = await report('broken everywhere')
    channel.setError(broken)
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'broken everywhere')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBe('')
    await waitFor(() => badge.isVisible(), false)

    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => badge.isVisible(), true)
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('1 error, 1 warning')
    expect(await overlay.locator('[data-action="restore"]').isVisible()).toBe(false)
    await badge.click()
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), null)
    expect(await overlay.locator('[data-overlay]').getAttribute('data-hidden')).toBeNull()
    await waitFor(() => badge.isVisible(), false)

    channel.clearError(broken.id)
    await waitFor(() => overlay.count(), 0)
    await waitFor(() => badge.getAttribute('data-kind'), 'warning')
    expect(await badge.locator('.mb-badge-count').textContent()).toBe('1 warning')
    expect(await page.evaluate(() => (window as unknown as { cleared: unknown[] }).cleared)).toEqual([broken.id])
    expect(await streams()).toEqual({ opened: 1, closed: 0 })
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('remembers a badge-expanded error across a reload', async () => {
    channel.clearWarning()
    channel.clearError()
    const broken = await report('badge expanded error')
    channel.setError(broken)
    const { page, errors } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const overlay = page.locator('my-bad-overlay')
    const dialog = overlay.locator('[data-overlay]')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'badge expanded error')
    expect(await dialog.getAttribute('data-minimized')).toBe('')

    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => badge.isVisible(), true)
    await badge.click()
    await waitFor(() => dialog.getAttribute('data-minimized'), null)

    await page.reload()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'badge expanded error')
    expect(await dialog.getAttribute('data-minimized')).toBeNull()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('mounts the error that is current when the page connects', async () => {
    channel.clearWarning()
    channel.setError(await report('before the page'))
    const { page, errors } = await open('/badge')
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'before the page')
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBe('')
    channel.clearError()
    await waitFor(() => overlay.count(), 0)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('shares one stream and one overlay with an overlay rendered into the page, whichever script runs first', async () => {
    for (const path of ['/badge-overlay', '/badge-overlay-first']) {
      channel.clearWarning()
      channel.setError(await report(`already shown ${path}`))
      const { page, errors, streams } = await open(path)
      const overlay = page.locator('my-bad-overlay')
      await waitFor(() => overlay.locator('[data-live][data-connected]').count(), 1)
      channel.warn(await warning('next to it'))
      await waitFor(() => overlay.locator('[data-warning-count]').textContent(), '1 warning')
      await page.waitForTimeout(300)
      expect(await overlay.count(), path).toBe(1)
      expect(await page.locator('my-bad-overlay-badge .mb-badge').isVisible(), path).toBe(false)

      channel.clearError()
      await waitFor(() => overlay.count(), 0)
      await waitFor(() => page.locator('my-bad-overlay-badge .mb-badge').isVisible(), true)
      expect(await streams(), path).toEqual({ opened: 1, closed: 0 })
      channel.clearWarning()
      expect(errors, path).toEqual([])
      await page.close()
    }
  }, 30_000)

  it('dismisses an overlay rendered into the page whose error cleared before the badge connected', async () => {
    channel.clearWarning()
    channel.clearError()
    const badge = renderBadge({ cwd: proj, channel: '/__my-bad', tag: 'nuxt-error-overlay' })
    const unknown = await report('never published')
    for (const order of ['badge first', 'overlay first']) {
      const stale = await report(`fixed before the badge connected, ${order}`)
      channel.setError(stale)
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => addEventListener('my-bad:error:clear', event => ((window as unknown as { cleared: unknown[] }).cleared ??= []).push((event as CustomEvent).detail.id)))
      const html = (shown: Awaited<ReturnType<typeof report>>) => {
        const overlay = renderOverlay(shown, {
          cwd: proj,
          channel: '/__my-bad',
          tag: 'nuxt-error-overlay',
          assets,
        })
        return `<!DOCTYPE html><html><head>${order === 'badge first'
          ? badge
          : ''}</head><body><h1 id="user">User page</h1>${overlay}${order === 'overlay first'
          ? badge
          : ''}</body></html>`
      }
      const pages = {
        '/stale': html(stale),
        '/unknown': html(unknown),
      }
      await page.route(`${origin}/{stale,unknown}`, route => route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname as keyof typeof pages] }))
      channel.clearError()

      await page.goto(`${origin}/stale`)
      await waitFor(() => page.locator('nuxt-error-overlay').count(), 0)
      expect(await page.evaluate(() => (window as unknown as { cleared: unknown[] }).cleared), order).toEqual([stale.id])

      await page.goto(`${origin}/unknown`)
      const overlay = page.locator('nuxt-error-overlay')
      await waitFor(() => overlay.locator('[data-live][data-connected]').count(), 1)
      await page.waitForTimeout(300)
      expect(await overlay.locator('[data-message]').first().textContent(), order).toBe('never published')
      expect(await page.evaluate(() => (window as unknown as { cleared?: unknown[] }).cleared), order).toBeUndefined()
      expect(errors, order).toEqual([])
      await page.close()
    }
  }, 30_000)

  it('works from a page rendered by another version of my-bad, which gets this build uncached', async () => {
    channel.clearWarning()
    channel.clearError()
    const state = (html: string) => JSON.parse(/<script type="application\/json">(.*?)<\/script>/s.exec(html)![1]!)
    const skewed = renderBadge({ cwd: proj, channel: '/__my-bad' }).replace(/\?v=\w+/g, '?v=0ther')
    const badgeState = state(skewed)
    const html = skewed.replace(/<script type="application\/json">.*?<\/script>/s, `<script type="application/json">${JSON.stringify({
      ...badgeState,
      future: true,
      overlay: {
        ...badgeState.overlay,
        version: '0.0.1',
        future: { nested: 1 },
      },
    })}</script>`)
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const caching: Record<string, string | null> = {}
    page.on('response', (response) => {
      if (response.url().includes('?v=')) {
        caching[new URL(response.url()).pathname] = response.headers()['cache-control'] ?? null
      }
    })
    await page.route(`${origin}/skewed`, route => route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><html><head>${html}</head><body><h1 id="user">User page</h1></body></html>` }))
    await page.goto(`${origin}/skewed`)
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    const overlay = page.locator('my-bad-overlay')

    channel.warn(await warning('across versions'))
    await waitFor(() => badge.isVisible(), true)
    await badge.click()
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'across versions')
    channel.setError(await report('broken across versions'))
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'broken across versions')
    expect(await overlay.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')
    expect(caching).toEqual({ '/__my-bad/badge.js': 'no-cache', '/__my-bad/client.js': 'no-cache', '/__my-bad/client.css': 'no-cache' })
    channel.clearError()
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('does not hold up parsing the page while its script loads', async () => {
    channel.clearWarning()
    channel.clearError()
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    await page.route(`${origin}/__my-bad/badge.js*`, async (route) => {
      await held
      await route.continue()
    })
    await page.goto(`${origin}/badge`, { waitUntil: 'commit' })
    await waitFor(() => page.evaluate(() => !!document.querySelector('#user')), true)
    release()
    channel.warn(await warning('after a deferred load'))
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-badge').isVisible(), true)
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('docks in the corner the host picks, unless the user has moved it', async () => {
    channel.clearWarning()
    channel.clearError()
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const badge = renderBadge({ cwd: proj, channel: '/__my-bad', dock: 'bottom-left' })
    await page.route(`${origin}/docked`, route => route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><html><head>${badge}</head><body><h1 id="user">User page</h1></body></html>` }))
    await page.goto(`${origin}/docked`)
    channel.warn(await warning('docked'))
    const pill = page.locator('my-bad-overlay-badge .mb-badge')
    await waitFor(() => pill.isVisible(), true)
    expect((await pill.boundingBox())!.x).toBeLessThan(600)
    await pill.click()
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-dock'), 'bottom-left')
    expect((await overlay.locator('[data-overlay]').boundingBox())!.x).toBeLessThan(600)

    await page.evaluate(() => localStorage.setItem('my-bad:overlay:dock', 'top-right'))
    await page.reload()
    await waitFor(() => pill.isVisible(), true)
    expect(await page.locator('my-bad-overlay-badge .mb-dock').getAttribute('data-dock')).toBe('top-right')
    channel.clearWarning()
    await page.close()
  }, 30_000)

  it('closes its stream while the tab is hidden and catches up when it returns', async () => {
    channel.clearWarning()
    channel.clearError()
    const stale = await warning('stale warning')
    channel.warn(stale)
    const { page, errors, streams } = await open('/badge')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    await waitFor(() => badge.isVisible(), true)

    await setHidden(page, true)
    expect(await streams()).toEqual({ opened: 1, closed: 1 })
    channel.clearWarning(stale.id)
    channel.warn(await warning('fresh warning'))
    channel.warn(await warning('another warning'))

    await setHidden(page, false)
    await waitFor(() => badge.locator('.mb-badge-count').textContent(), '2 warnings')
    expect((await streams()).opened).toBe(2)
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('dismisses an overlay whose error cleared while the tab was hidden', async () => {
    channel.clearWarning()
    const missed = await report('fixed in the background')
    channel.setError(missed)
    const { page, errors } = await open('/badge')
    await page.evaluate(() => addEventListener('my-bad:error:clear', event => ((window as unknown as { cleared: unknown[] }).cleared ??= []).push((event as CustomEvent).detail.id)))
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-live][data-connected]').count(), 1)

    await setHidden(page, true)
    channel.clearError()
    await setHidden(page, false)
    await waitFor(() => overlay.count(), 0)
    expect(await page.evaluate(() => (window as unknown as { cleared: unknown[] }).cleared)).toEqual([missed.id])
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('counts problem sets beside the warnings', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const typeError = await report('Type \'number\' is not assignable to type \'string\'')
    channel.setProblems('ts', [typeError], { label: 'TypeScript', status: 'idle', url: '/__typecheck/' })
    channel.setProblems('lint', [], { label: 'ESLint', status: 'checking' })
    const { page, errors } = await open('/badge')
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    const entries = problems.locator('.mb-problems-count > *')
    const badge = page.locator('my-bad-overlay-badge .mb-badge')
    await waitFor(() => problems.isVisible(), true)
    expect(await badge.isVisible()).toBe(false)
    expect(await problems.textContent()).toBe('TypeScript 1')
    expect(await problems.getByRole('button', { name: 'TypeScript 1' }).getAttribute('title')).toBe('TypeScript: 1 error')
    expect(await problems.locator('.mb-spin').count()).toBe(1)
    const spinning = () => problems.locator('.mb-spin').evaluate(icon => icon.getAnimations().length)
    expect(await spinning()).toBe(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await spinning()).toBe(0)
    expect(await page.locator('my-bad-overlay').count()).toBe(0)

    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], { label: 'ESLint', status: 'idle', url: '/__lint/' })
    await waitFor(() => problems.textContent(), 'TypeScript 1 · ESLint 1')
    expect(await entries.evaluateAll(items => items.map(item => [
      item.textContent,
      (item as HTMLElement).title,
    ]))).toEqual([
      ['TypeScript 1', 'TypeScript: 1 error'],
      ['ESLint 1', 'ESLint: 1 warning'],
    ])
    expect(await problems.locator('.mb-spin').count()).toBe(0)
    expect(await problems.getAttribute('data-kind')).toBe('error')

    channel.warn(await warning('careful'))
    await waitFor(() => badge.isVisible(), true, 10_000)
    const [pill, link] = await Promise.all([
      badge.boundingBox(),
      problems.boundingBox(),
    ])
    expect(link!.x + link!.width).toBeLessThan(pill!.x)
    expect(link!.y).toBe(pill!.y)

    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], { label: 'ESLint', status: 'checking' })
    channel.clearProblems('ts')
    await waitFor(() => problems.textContent(), 'ESLint 1')
    expect(await entries.evaluateAll(items => items.map(item => [item.tagName, (item as HTMLElement).title]))).toEqual([
      ['BUTTON', 'ESLint: 1 warning (checking)'],
    ])
    expect(await problems.getAttribute('data-kind')).toBe('warning')
    channel.clearProblems()
    await waitFor(() => problems.isVisible(), false)
    expect(await badge.isVisible()).toBe(true)
    channel.clearWarning()
    await waitFor(() => badge.isVisible(), false)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('grows the problems pill into one card for reports that arrive together, holds it while hovered, then shrinks it back', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    const { page, errors } = await open('/badge', page => page.clock.install())
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    expect(await problems.isVisible()).toBe(true)
    expect(await peek.isVisible()).toBe(false)

    channel.setProblems('ts', [mismatch, await report('Another mismatch'), await report('Third mismatch')], { label: 'TypeScript' })
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.locator('.mb-peek-message').textContent()).toBe('Error: Another mismatch')
    expect(await peek.locator('.mb-peek-meta').textContent()).toBe('TypeScript · src/handler.ts:2 · and 1 more')
    await waitFor(() => problems.isVisible(), false)
    await waitFor(() => page.locator('my-bad-overlay-badge [role="status"]').textContent(), 'TypeScript: Error: Error: Another mismatch, and 1 more')

    await peek.hover()
    await page.clock.fastForward(10_000)
    await page.waitForTimeout(500)
    expect(await peek.isVisible()).toBe(true)
    await page.mouse.move(10, 10)
    await page.clock.fastForward(7000)
    await waitFor(() => peek.isVisible(), false)
    expect(await problems.isVisible()).toBe(true)
    expect(await problems.textContent()).toBe('TypeScript 3')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('announces a problem report again once its source was cleared', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Returning mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    channel.clearProblems('ts')
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-problems').isVisible(), false)
    expect(await peek.isVisible()).toBe(false)
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Returning mismatch')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('shows the hint of a problem in its card', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const first = createProblemReport({
      name: 'ESLint',
      message: 'Unused variable',
      file: `${proj}/src/handler.ts`,
      line: 2,
    })
    channel.setProblems('lint', [first], { label: 'ESLint' })
    const { page, errors } = await open('/badge', page => page.clock.install())
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)

    channel.setProblems('lint', [
      first,
      createProblemReport({
        name: 'ESLint',
        message: 'Missing return type',
        hint: 'Annotate the return type.',
        file: `${proj}/src/handler.ts`,
        line: 2,
      }),
    ], { label: 'ESLint' })
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.locator('.mb-peek-hint').textContent()).toBe('Annotate the return type.')
    expect(await peek.locator('.mb-peek-hint').isVisible()).toBe(true)
    await page.clock.fastForward(7000)
    await waitFor(() => peek.isVisible(), false)

    channel.setProblems('lint', [
      first,
      createProblemReport({
        name: 'ESLint',
        message: 'No hint here',
        file: `${proj}/src/handler.ts`,
        line: 2,
      }),
    ], { label: 'ESLint' })
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'No hint here')
    await waitFor(() => page.locator('my-bad-overlay-badge [role="status"]').textContent(), 'ESLint: Error: No hint here')
    expect(await peek.locator('.mb-peek-hint').isVisible()).toBe(false)
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('leaves info problems out of the pill and the card', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const info = (message: string) => createProblemReport({ name: 'Checker', message, kind: 'info' })
    channel.setProblems('checker', [
      info('Consider a type annotation'),
    ], { label: 'Checker' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    expect(await page.locator('my-bad-overlay-badge .mb-problems').isVisible()).toBe(false)

    channel.setProblems('checker', [
      info('Consider a type annotation'),
      info('Prefer a const'),
      createProblemReport({ name: 'Checker', message: 'Type mismatch' }),
    ], { label: 'Checker' })
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.locator('.mb-peek-message').textContent()).toBe('Type mismatch')
    expect(await peek.locator('.mb-peek-meta').textContent()).toBe('Checker')
    expect(await page.locator('my-bad-overlay-badge .mb-problems').textContent()).toBe('Checker 1')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('renders code spans in the card of a report that uses them', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const first = createProblemReport({ name: 'SFC', message: 'Unused `ref`' })
    channel.setProblems('vue', [first], { label: 'Vue' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)

    channel.setProblems('vue', [
      first,
      createProblemReport({
        name: 'SFC',
        message: '`<defineProps>` is a compiler macro',
        hint: 'Remove the `import`.',
      }, { codeSpans: true }),
    ], { label: 'Vue' })
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.locator('.mb-peek-message').innerHTML()).toBe('SFC: <code>&lt;defineProps&gt;</code> is a compiler macro')
    expect(await peek.locator('.mb-peek-hint').innerHTML()).toBe('Remove the <code>import</code>.')
    await waitFor(() => page.locator('my-bad-overlay-badge [role="status"]').textContent(), 'Vue: Error: SFC: <defineProps> is a compiler macro')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('ignores reports fetched for a source cleared while the fetch was in flight', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    const late = await report('Late mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let requested = false
    await page.route('**/__my-bad/problems', async (route) => {
      requested = true
      const response = await route.fetch()
      await held
      await route.fulfill({ response })
    })
    channel.setProblems('ts', [mismatch, late], { label: 'TypeScript' })
    await waitFor(() => requested, true)
    channel.clearProblems('ts')
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-problems').isVisible(), false)
    const received = page.evaluate(() => new Promise(resolve => window.__MY_BAD_SOURCE__!.addEventListener('reports', resolve, { once: true })))
    release()
    await received
    await page.unroute('**/__my-bad/problems')
    channel.setProblems('ts', [mismatch, late], { label: 'TypeScript' })
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Type mismatch')
    expect(await peek.locator('.mb-peek-meta').textContent()).toBe('TypeScript · src/handler.ts:2 · and 1 more')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('counts only the shown source\'s other new reports on a card', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    const unused = await report('Unused variable')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    channel.setProblems('lint', [unused], { label: 'ESLint' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems.filter(set => set.reports?.length).length), 2)
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let requested = false
    await page.route('**/__my-bad/problems', async (route) => {
      requested = true
      await held
      await route.continue()
    })
    channel.setProblems('ts', [mismatch, await report('Second mismatch'), await report('Third mismatch')], { label: 'TypeScript' })
    await waitFor(() => requested, true)
    channel.setProblems('lint', [unused, await report('Unused import')], { label: 'ESLint' })
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-problems').textContent(), 'TypeScript 3 · ESLint 2')
    release()
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Second mismatch')
    expect(await peek.locator('.mb-peek-meta').textContent()).toBe('TypeScript · src/handler.ts:2 · and 1 more')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it.each(['no-preference', 'reduce'] as const)('grows the card out of its pill, or fades it in when motion is reduced (%s)', async (reducedMotion) => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const { page, errors } = await open('/badge', async (page) => {
      await page.emulateMedia({ reducedMotion })
      await page.addInitScript(() => {
        const animate = Element.prototype.animate
        const held: Animation[] = []
        Object.assign(window, { held })
        Element.prototype.animate = function (keyframes, options) {
          const animation = animate.call(this, keyframes, options)
          if (this.classList.contains('mb-peek')) {
            animation.pause()
            held.push(animation)
          }
          return animation
        }
      })
    })
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.snapshot?.().ready), true)
    channel.warn({
      ...await report('Animated warning'),
      kind: 'warning',
    })
    const card = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => card.isVisible(), true)
    const pill = (await page.locator('my-bad-overlay-badge .mb-badge').boundingBox())!
    const [start, middle, end] = await card.evaluate((el) => {
      const [animation] = (window as unknown as { held: Animation[] }).held
      const { delay, duration } = animation!.effect!.getTiming()
      return [0, 0.5, 1].map((progress) => {
        animation!.currentTime = delay! + Number(duration) * progress
        const box = el.getBoundingClientRect()
        return {
          width: box.width,
          height: box.height,
          opacity: Number(getComputedStyle(el).opacity),
        }
      })
    })
    expect(start!.opacity).toBe(0)
    expect(end!.opacity).toBe(1)
    if (reducedMotion === 'reduce') {
      expect(middle!.opacity).toBeGreaterThan(0)
      expect(middle!.opacity).toBeLessThan(1)
      expect(start!.width).toBe(end!.width)
      expect(start!.height).toBe(end!.height)
    }
    else {
      expect(start!.width).toBeCloseTo(pill.width, 0)
      expect(start!.height).toBeCloseTo(pill.height, 0)
      expect(middle!.width).toBeGreaterThan(start!.width)
      expect(end!.width).toBeGreaterThan(middle!.width)
      expect(end!.height).toBeGreaterThan(start!.height)
    }
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('holds a card while it has keyboard focus', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const { page, errors } = await open('/badge', page => page.clock.install())
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.snapshot?.().ready), true)
    channel.warn(await warning('Focused warning'))
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => peek.isVisible(), true)
    await peek.focus()
    await page.clock.fastForward(10_000)
    await page.waitForTimeout(500)
    expect(await peek.isVisible()).toBe(true)
    await peek.blur()
    await page.clock.fastForward(7000)
    await waitFor(() => peek.isVisible(), false)
    channel.clearWarning()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('opens the report a card shows when it is clicked', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript', url: '/__typecheck/' })
    const { page, errors } = await open('/badge')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    const panel = page.frameLocator('my-bad-overlay-badge .mb-drawer iframe')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    channel.setProblems('ts', [mismatch, await report('Later mismatch')], { label: 'TypeScript', url: '/__typecheck/' })
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Later mismatch')
    await peek.click()
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Later mismatch')
    await waitFor(() => peek.isVisible(), false)
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('opens a problem set in a drawer beside the badge, with its full list', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript', url: '/__typecheck/' })
    const { page, errors } = await open('/badge')
    await page.route('**/__typecheck/', route => route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html lang="en"><title>Type check</title><h1>Type check</h1></html>' }))
    const pill = page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' })
    const drawer = page.locator('my-bad-overlay-badge .mb-drawer')
    const panel = page.frameLocator('my-bad-overlay-badge .mb-drawer iframe')
    const focused = () => pill.evaluate(el => (el.getRootNode() as ShadowRoot).activeElement === el)
    await pill.click()
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    expect(await drawer.getAttribute('data-dock')).toBe('bottom-right')
    expect(await page.locator('my-bad-overlay').count()).toBe(0)

    await panel.getByRole('button', { name: 'Show the full list' }).click()
    await waitFor(() => panel.locator('.mb-docked-list').getAttribute('src').catch(() => null), '/__typecheck/')
    expect(await panel.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe('/__typecheck/')
    expect(await panel.getByRole('button', { name: 'Show the full list' }).getAttribute('aria-pressed')).toBe('true')
    await panel.frameLocator('.mb-docked-list').getByRole('heading', { name: 'Type check' }).waitFor()
    expect((await panel.locator('.mb-docked-list').boundingBox())!.height).toBeGreaterThan(300)

    channel.setProblems('ts', [mismatch], { label: 'TypeScript', url: '/__typecheck/?all' })
    await waitFor(() => panel.locator('.mb-docked-list').getAttribute('src').catch(() => null), '/__typecheck/?all')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript' })
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    expect(await panel.locator('.mb-docked-list').count()).toBe(0)

    await panel.getByRole('button', { name: 'Close' }).click()
    await waitFor(() => drawer.count(), 0)
    expect(await focused()).toBe(true)

    await pill.click()
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    await page.keyboard.press('Escape')
    await waitFor(() => drawer.count(), 0)
    expect(await focused()).toBe(true)
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('opens the drawer from the channel it connected to after the page navigates', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    const { page, errors } = await open('/nested/badge-relative')
    await page.evaluate(() => history.pushState(null, '', '/elsewhere/deeper/page'))
    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' }).click()
    expect(await page.locator('my-bad-overlay-badge .mb-drawer iframe').getAttribute('src')).toBe(`${origin}/__my-bad/panel?embed&drawer`)
    await waitFor(() => page.frameLocator('my-bad-overlay-badge .mb-drawer iframe').locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('points a page whose problem reports are withheld at the dev machine', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    const { page, errors } = await open('/badge')
    await page.route('**/__my-bad/problems', route => route.fulfill({ status: 403 }))
    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' }).click()
    const panel = page.frameLocator('my-bad-overlay-badge .mb-drawer iframe')
    await waitFor(() => panel.locator('.mb-docked-empty-title').textContent().catch(() => ''), 'Problems listed on the dev machine')
    expect(await panel.locator('[data-index-source="ts"] .mb-count').textContent()).toBe('1 error')
    channel.clearProblems()
    await waitFor(() => panel.locator('.mb-docked-empty-title').textContent().catch(() => ''), 'No problems')
    expect(errors.filter(error => !error.includes('403'))).toEqual([])
    await page.close()
  }, 30_000)

  it('resyncs problem sets that changed while the tab was hidden', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('ts', [await report('stale')], { label: 'TypeScript' })
    const { page, errors } = await open('/badge')
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    await waitFor(() => problems.isVisible(), true)
    await setHidden(page, true)
    channel.setProblems('ts', [], { label: 'TypeScript' })
    await setHidden(page, false)
    await waitFor(() => problems.isVisible(), false)
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('shows a failed source with its reason instead of a count', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('ts', [await report('stale')], { label: 'TypeScript', status: 'failed', error: 'Cannot find module \'typescript\'' })
    channel.setProblems('lint', [], { label: 'ESLint', status: 'failed' })
    const { page, errors } = await open('/badge')
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    await waitFor(() => problems.isVisible(), true)
    expect(await problems.textContent()).toBe('TypeScript failed · ESLint failed')
    expect(await problems.locator('.mb-problems-count > *').evaluateAll(items => items.map(item => (item as HTMLElement).title))).toEqual(['TypeScript: failed: Cannot find module \'typescript\'', 'ESLint: failed'])
    expect(await problems.getAttribute('data-kind')).toBe('error')

    channel.setProblems('ts', [], { label: 'TypeScript', status: 'idle' })
    await waitFor(() => problems.textContent(), 'ESLint failed')
    channel.clearProblems()
    await waitFor(() => problems.isVisible(), false)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('counts the sources of a group together', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const warned = async (message: string) => ({
      ...await report(message),
      kind: 'warning' as const,
    })
    channel.setProblems('nuxt:components', [await warned('Two components named Foo')], { label: 'Components', group: 'Nuxt' })
    channel.setProblems('nuxt:imports', [await warned('Duplicated imports'), await warned('Overrides a built-in')], { label: 'Imports', group: 'Nuxt' })
    channel.setProblems('vue:compiler', [await warned('<p> cannot be child of <p>')], { label: 'Vue' })
    const { page, errors } = await open('/badge')
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    await waitFor(() => problems.isVisible(), true)
    expect(await problems.textContent()).toBe('Nuxt 3 · Vue 1')
    expect(await problems.locator('.mb-problems-count > *').evaluateAll(items => items.map(item => (item as HTMLElement).title))).toEqual(['Nuxt Components: 1 warning; Nuxt Imports: 2 warnings', 'Vue: 1 warning'])

    channel.setProblems('nuxt:pages', [await warned('Duplicate route name')], {
      label: 'Pages',
      group: 'Nuxt',
      status: 'failed',
      error: 'Could not scan pages',
    })
    await waitFor(() => problems.textContent(), 'Nuxt 3, 1 failed · Vue 1')
    expect(await problems.getAttribute('data-kind')).toBe('error')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('refuses a problem set url that is not http', async () => {
    channel.clearProblems()
    channel.setProblems('ts', [await report('x')], { label: 'TypeScript', url: 'javascript:alert(1)' })
    const { page } = await open('/badge')
    const problems = page.locator('my-bad-overlay-badge .mb-problems')
    await waitFor(() => problems.isVisible(), true)
    expect(await problems.locator('a').count()).toBe(0)
    channel.clearProblems()
    await page.close()
  }, 30_000)
})

describe('multi-line messages', () => {
  it('heads the overlay with the first line and expands the rest of the body', async () => {
    channel.clearError()
    const current = await report('Two components are named Widget:')
    current.message = `Two components are named Widget:\n - ~/a.vue\n${' - ~/b.vue\n'.repeat(200)}`
    channel.setError(current)
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/overlay`)
    const root = page.locator('[data-my-bad-root]')
    await waitFor(() => root.locator('h1').textContent(), 'Two components are named Widget:')
    const body = root.locator('[data-message-body]')
    expect(await body.isVisible()).toBe(true)
    expect((await body.textContent())!.startsWith(' - ~/a.vue\n - ~/b.vue')).toBe(true)
    expect(await body.locator('[data-message-rest]').isVisible()).toBe(false)
    await body.getByRole('button', { name: /Show full message/ }).click()
    expect(await body.locator('[data-message-rest]').isVisible()).toBe(true)
    expect(errors).toEqual([])
    await page.close()
    channel.clearError()
  }, 30_000)
})

describe('source-first inspection', () => {
  it('keeps source in place, scopes context and compiled views, and reveals supporting evidence', async () => {
    const current = await report('Cannot save this widget')
    current.frames[0]!.line = 6
    current.frames[0]!.snippet = {
      start: 1,
      lines: Array.from({ length: 11 }, (_, i) => `const line${i + 1} = ${i + 1}`),
    }
    current.frames[0]!.compiled = {
      file: `${proj}/dist/handler.js`,
      line: 20,
      column: 9,
      snippet: {
        start: 20,
        lines: ['throw Error()'],
      },
    }
    current.frames.splice(1, 0, {
      type: 'app',
      file: `${proj}/caller.ts`,
      function: 'caller',
      line: 2,
      snippet: {
        start: 1,
        lines: ['start()', 'handler()', 'finish()'],
      },
    })
    current.causes = [
      {
        ...current,
        id: 'inner',
        message: 'Missing name',
        frames: [],
        causes: [],
      },
    ]
    current.trace = [
      { label: '<Widget>' },
    ]
    channel.setError(current)
    for (const path of ['/', '/overlay']) {
      const page = await browser.newPage()
      await page.goto(`${origin}${path}`)
      const root = page.locator('[data-my-bad-root]')
      await waitFor(() => root.locator('[data-live][data-connected]').count(), 1)
      const source = root.locator('.mb-source').first()
      const stack = root.locator('[data-stack]').first()
      expect(await root.locator('h1').textContent()).toBe(current.message)
      expect(await root.locator('[data-fallback]').count()).toBe(0)
      expect(await source.locator('.mb-line:not(.mb-line-caret):visible').count()).toBe(7)
      await source.getByRole('button', { name: 'More context', exact: true }).click()
      expect(await source.locator('.mb-line:not(.mb-line-caret):visible').count()).toBe(11)
      await source.getByRole('button', { name: 'Less context', exact: true }).click()
      await source.locator('[data-switch="compiled"]').click()
      expect(await source.locator('[data-snippet-compiled]').isVisible()).toBe(true)
      const requests = openRequests.length
      await source.locator('[data-location-compiled] [data-loc]').click()
      await waitFor(() => openRequests.length, requests + 1)
      expect(openRequests.at(-1)).toEqual({ file: `${proj}/src/handler.ts`, line: 6, column: 3 })
      await source.locator('[data-switch="source"]').click()
      expect(await source.locator('.mb-line:not(.mb-line-caret):visible').count()).toBe(7)
      const before = await source.boundingBox()
      await stack.locator('[data-action="stack"]').focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      const focus = await stack.locator('[data-action="stack"]').evaluate((button) => {
        const style = getComputedStyle(button)
        const rect = button.getBoundingClientRect()
        const card = button.closest('.mb-ordered-stack')!.getBoundingClientRect()
        const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)
        return {
          visible: button.matches(':focus-visible') && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
          contained: rect.top - reach >= card.top && rect.bottom + reach <= card.bottom
            && rect.left - reach >= card.left && rect.right + reach <= card.right,
        }
      })
      expect(focus).toEqual({ visible: true, contained: true })
      await page.keyboard.press('Enter')
      const caller = stack.locator('[data-frame-type="app"]').first()
      expect(await caller.locator('[data-snippet-source]').isVisible()).toBe(true)
      const callerRequests = openRequests.length
      await caller.locator('[data-loc]').focus()
      await page.keyboard.press('Enter')
      await waitFor(() => openRequests.length, callerRequests + 1)
      expect(openRequests.at(-1)).toEqual({ file: `${proj}/caller.ts`, line: 2 })
      expect(await source.boundingBox()).toEqual(before)
      expect(await root.getByRole('region', { name: 'Error source', exact: true }).count()).toBe(1)
      expect(await stack.locator('.mb-framework-hidden').isVisible()).toBe(true)
      expect(await stack.locator('[data-frame-type="vendor"]').isVisible()).toBe(false)
      await stack.getByRole('switch').click()
      expect(await stack.locator('[data-frame-type="vendor"]').first().isVisible()).toBe(true)
      expect(await stack.locator('.mb-framework-hidden').isVisible()).toBe(false)
      await stack.locator('[data-action="stack"]').click()
      expect(await caller.locator('[data-snippet-source]').isVisible()).toBe(false)
      expect(await source.boundingBox()).toEqual(before)
      await root.locator('[data-action="cause"][data-path="rc0"]').click()
      expect(await root.getByRole('heading', { name: 'Missing name', exact: true }).isVisible()).toBe(true)
      await root.locator('[data-action="cause"][data-path="r"]').click()
      expect(await root.locator('h1').textContent()).toBe(current.message)
      await root.locator('.mb-disclosure > summary').filter({ hasText: 'Component trace' }).click()
      expect(await root.locator('[data-trace]').isVisible()).toBe(true)
      await page.close()
    }
  }, 30_000)
})

describe('server logs', () => {
  it('distinguishes connection status, unread logs, empty logs and filtered results', async () => {
    channel.setError(await report('Log states'))
    for (const path of ['/', '/overlay']) {
      const page = await browser.newPage()
      await page.goto(`${origin}${path}`)
      const root = page.locator('[data-my-bad-root]')
      await waitFor(() => root.locator('[data-live][data-connected]').count(), 1)
      const trigger = root.getByRole('button', { name: 'Server logs', exact: true })
      expect(await trigger.locator('[data-live]').count()).toBe(0)
      expect(await trigger.locator('[data-log-count]').isVisible()).toBe(false)
      await trigger.click()
      expect(await root.locator('[data-live-text]').textContent()).toBe('Dev server: connected')
      expect(await root.locator('[data-log-empty]').textContent()).toBe('No logs received yet.')
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(true)
      channel.setError(await report('Still waiting for logs'))
      await waitFor(() => root.locator('h1').textContent(), 'Still waiting for logs')
      expect(await root.locator('[data-logs]').isVisible()).toBe(true)
      channel.log({ level: 'info', text: 'Server ready' })
      await waitFor(() => root.locator('[data-log]').count(), 1)
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(false)
      await root.locator('[data-log-filter]').selectOption('error')
      expect(await root.locator('[data-log-empty]').textContent()).toBe('No logs match this level.')
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(true)
      channel.setError(await report('Keep the filter'))
      await waitFor(() => root.locator('h1').textContent(), 'Keep the filter')
      expect(await root.locator('[data-log-filter]').inputValue()).toBe('error')
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(true)
      await root.getByRole('button', { name: 'Close server logs' }).click()
      channel.log({ level: 'error', text: 'An actual unread error' })
      await waitFor(() => trigger.locator('[data-log-count]').textContent(), '1')
      expect(await trigger.locator('[data-log-count]').isVisible()).toBe(true)
      await trigger.click()
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(false)
      expect(await trigger.locator('[data-log-count]').isVisible()).toBe(false)
      await root.getByRole('button', { name: 'Clear logs', exact: true }).click()
      expect(await root.locator('[data-log-empty]').textContent()).toBe('No logs received yet.')
      expect(await root.locator('[data-log-empty]').isVisible()).toBe(true)
      await page.close()
    }
  })
})

describe('copy formats', () => {
  it('copies the report directly and offers the proposal formats with a useful agent prompt', async () => {
    channel.setError(await report('Copy this failure'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.assign(window, { testClipboard: '' })
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => Object.assign(window, { testClipboard: text }),
        },
      })
    })
    await page.goto(origin)
    const copied = () => page.evaluate(() => (window as Window & { testClipboard?: string }).testClipboard ?? '')
    await page.getByRole('button', { name: 'Copy error', exact: true }).click()
    await waitFor(async () => (await copied()).includes('Copy this failure'), true)
    const markdown = await copied()
    await page.getByRole('button', { name: 'More copy formats' }).click()
    expect(await page.locator('[data-menu-list] button').allTextContents()).toEqual(['Copy as Markdown', 'Copy prompt for an agent', 'Copy structured JSON'])
    await page.getByRole('button', { name: 'Copy prompt for an agent' }).click()
    await waitFor(async () => (await copied()).startsWith('Help diagnose this error.'), true)
    expect(await copied()).toContain(markdown)
    await page.getByRole('button', { name: 'Copy structured JSON' }).click()
    await waitFor(async () => (await copied()).startsWith('{'), true)
    expect(JSON.parse(await copied()).message).toBe('Copy this failure')
    expect(await page.locator('[data-action="info"]').count()).toBe(0)
    await page.close()
  })

  it('falls back to execCommand when the async clipboard refuses', async () => {
    channel.setError(await report('Clipboard refused'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.assign(window, { testClipboard: '' })
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('Write permission denied')
          },
        },
      })
      document.execCommand = () => {
        Object.assign(window, { testClipboard: (document.activeElement as HTMLTextAreaElement).value })
        return true
      }
    })
    await page.goto(`${origin}/overlay`)
    await page.getByRole('button', { name: 'Copy error', exact: true }).click()
    await waitFor(async () => (await page.evaluate(() => (window as Window & { testClipboard?: string }).testClipboard ?? '')).includes('Clipboard refused'), true)
    await waitFor(() => page.getByRole('button', { name: 'Copied', exact: true }).count(), 1)
    expect(await page.locator('textarea[data-my-bad]').count()).toBe(0)
    await page.close()
  })

  it('restores the button label after repeated copies', async () => {
    channel.setError(await report('Copy twice'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {},
        },
      })
    })
    await page.goto(origin)
    const button = page.getByRole('button', { name: 'Copy error', exact: true })
    await button.click()
    await page.locator('[data-copied]').click()
    await page.locator('[data-copied]').click()
    await waitFor(() => button.count(), 1, 4000)
    expect(await page.locator('[data-copied]').count()).toBe(0)
    await page.close()
  })

  it('offers a keyboard copy when every clipboard path is refused', async () => {
    channel.setError(await report('Clipboard unavailable'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('Write permission denied')
          },
        },
      })
      document.execCommand = () => false
    })
    await page.goto(`${origin}/overlay`)
    await page.getByRole('button', { name: 'Copy error', exact: true }).click()
    await waitFor(() => page.locator('[data-copy-failed]').count(), 1)
    expect(await page.locator('[data-copy-failed]').textContent()).toMatch(/Press (?:\u2318C|Ctrl\+C)/)
    expect(await page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>('textarea[data-my-bad]')
      return area && area.selectionEnd - area.selectionStart === area.value.length && area.value.includes('Clipboard unavailable')
    })).toBe(true)
    await page.keyboard.press('Escape')
    await waitFor(() => page.locator('textarea[data-my-bad]').count(), 0)
    await waitFor(() => page.getByRole('button', { name: 'Copy error', exact: true }).count(), 1)
    await page.close()
  })
})

describe('copy location', () => {
  async function compiledReport(message: string) {
    const r = await report(message)
    r.frames[0]!.compiled = {
      file: `${proj}/dist/handler.js`,
      line: 7,
      column: 11,
      snippet: {
        start: 6,
        lines: ['var a = 1', 'throw new Error()'],
      },
    }
    return r
  }

  it('copies the position of the view the frame shows and announces it', async () => {
    channel.setError(await compiledReport('Copy a location'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.assign(window, { testClipboard: '' })
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => Object.assign(window, { testClipboard: text }),
        },
      })
    })
    await page.goto(origin)
    const copied = () => page.evaluate(() => (window as Window & { testClipboard?: string }).testClipboard ?? '')
    const source = page.locator('.mb-source').first()
    await source.getByRole('button', { name: 'Copy location', exact: true }).click()
    await waitFor(copied, `${proj}/src/handler.ts:2:3`)
    await waitFor(() => source.getByRole('button', { name: 'Copied location', exact: true }).count(), 1)
    await waitFor(async () => (await page.locator('[data-announce]').textContent())?.includes(`${proj}/src/handler.ts:2:3`), true)
    await waitFor(() => source.getByRole('button', { name: 'Copy location', exact: true }).count(), 1, 4000)

    await source.getByRole('button', { name: 'Compiled', exact: true }).click()
    await source.getByRole('button', { name: 'Copy location', exact: true }).click()
    await waitFor(copied, `${proj}/dist/handler.js:7:11`)

    const requests = openRequests.length
    await source.getByRole('button', { name: 'Open original source in your editor', exact: true }).click()
    await waitFor(() => openRequests.length, requests + 1)
    await page.close()
  })

  it('copies and opens a location that names only a file', async () => {
    const current = await report('Named only a file')
    current.frames = [
      { file: `${proj}/caller.ts`, type: 'app' },
    ]
    channel.setError(current)
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.assign(window, { testClipboard: '' })
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => Object.assign(window, { testClipboard: text }),
        },
      })
    })
    await page.goto(origin)
    const copied = () => page.evaluate(() => (window as Window & { testClipboard?: string }).testClipboard ?? '')
    const source = page.locator('.mb-source[data-file-only]')
    await waitFor(() => source.count(), 1)
    expect(await source.locator('[data-loc]').textContent()).toBe('caller.ts')
    expect(await page.locator('.mb-unavailable').count()).toBe(0)
    await source.getByRole('button', { name: 'Copy location', exact: true }).click()
    await waitFor(copied, `${proj}/caller.ts`)
    const requests = openRequests.length
    await source.getByRole('button', { name: 'Open original source in your editor', exact: true }).click()
    await waitFor(() => openRequests.length, requests + 1)
    expect(openRequests.at(-1)).toEqual({ file: `${proj}/caller.ts` })
    await page.close()
  })

  it('keeps the icon button compact while offering a keyboard copy', async () => {
    channel.setError(await compiledReport('Copy a location by hand'))
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async () => {
            throw new Error('Write permission denied')
          },
        },
      })
      document.execCommand = () => false
    })
    await page.goto(origin)
    const source = page.locator('.mb-source').first()
    const button = source.getByRole('button', { name: 'Copy location', exact: true })
    const width = (await button.boundingBox())!.width
    await button.click()
    const prompt = source.getByRole('button', { name: /^Press (?:\u2318C|Ctrl\+C) to copy the location$/ })
    await waitFor(() => prompt.count(), 1)
    expect((await prompt.boundingBox())!.width).toBe(width)
    expect(await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[data-my-bad]')?.value)).toBe(`${proj}/src/handler.ts:2:3`)
    await page.keyboard.press('Escape')
    await waitFor(() => source.getByRole('button', { name: 'Copy location', exact: true }).count(), 1)
    await page.close()
  })
})

describe('theme before first paint', () => {
  it('applies the remembered scheme without the client script', async () => {
    const page = await browser.newPage({ colorScheme: 'dark' })
    await page.addInitScript(() => localStorage.setItem('my-bad:theme', 'light'))
    await page.route('**/client.js', route => route.abort())
    await page.goto(`${origin}/page-external`)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await page.close()
  })

  it('follows the system preference when storage is unavailable', async () => {
    const page = await browser.newPage({ colorScheme: 'dark' })
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }))
    await page.route('**/client.js', route => route.abort())
    await page.goto(`${origin}/page-external`)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.close()
  })
})

describe('accessibility', () => {
  it('has labelled controls, landmarks and keyboard navigation', async () => {
    channel.setError(await report('a11y'))
    const page = await browser.newPage()
    await page.goto(origin)
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'a11y')

    const unlabelled = await page.evaluate(() => [
      ...document.querySelectorAll('button'),
    ].filter(button => !button.textContent?.trim() && !button.getAttribute('aria-label')).map(button => button.outerHTML.slice(0, 80)))
    expect(unlabelled).toEqual([])
    expect(await page.locator('main[tabindex="-1"]').count()).toBe(1)
    expect(await page.locator('article[aria-labelledby]').count()).toBeGreaterThan(0)
    expect(await page.locator('h1').count()).toBe(1)
    expect(await page.evaluate(() => document.querySelector('pre code div'))).toBeNull()
    expect(await page.locator('[role="menu"]').count()).toBe(0)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN')

    await waitFor(() => page.locator('[data-live][data-connected]').count(), 1)
    const requests = openRequests.length
    await page.getByRole('button', { name: 'Open original source in your editor', exact: true }).first().click()
    await waitFor(() => openRequests.length, requests + 1)
    expect(openRequests.at(-1)).toEqual({ file: `${proj}/src/handler.ts`, line: 2, column: 3 })
    await page.close()
  }, 30_000)
})

describe('devtools dock', () => {
  interface Calls {
    switched: string[]
    badges: Array<{ badge?: string, badgeVariant?: string, title?: string }>
    messages: Record<string, { message: string, description?: string, level: string, status?: string, notify?: boolean, filePosition?: unknown, actions?: Array<{ id: string, activate: { dockId: string, params?: Record<string, unknown> } }> }>
    added: string[]
    removed: string[]
  }

  async function open(path: string) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}${path}`)
    const calls = () => page.evaluate(() => (window as unknown as { devtools: { calls: Calls } }).devtools.calls)
    return { page, errors, calls }
  }

  it('hands the badge to the dock, and mirrors its counts and reports as DevTools messages', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const typeError = await report('Type mismatch')
    channel.setProblems('ts', [typeError], { label: 'TypeScript', url: '/__typecheck/' })
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).badges.at(-1)?.badge, '1')
    expect((await calls()).badges.at(-1)).toEqual({ badge: '1', badgeVariant: 'danger', title: 'my-bad (1 error)' })
    await waitFor(async () => (await calls()).messages['my-bad:problems:ts']?.filePosition !== undefined, true)
    const problems = (await calls()).messages['my-bad:problems:ts']!
    expect(problems).toMatchObject({
      message: 'TypeScript: 1 error',
      level: 'error',
      filePosition: { file: `${proj}/src/handler.ts`, line: 2, column: 3 },
    })
    expect(problems.notify).toBeUndefined()
    expect(problems.actions!.map(action => [action.id, action.activate])).toEqual([
      [
        'show',
        {
          dockId: 'my-bad',
          params: { source: 'ts' },
        },
      ],
      [
        'list',
        {
          dockId: 'my-bad',
          params: { source: 'ts', list: true },
        },
      ],
    ])

    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' }).click()
    expect((await calls()).switched).toEqual(['my-bad'])
    const panel = page.frameLocator('iframe')
    const current = panel.locator('.mb-index-item[aria-current="true"]')
    await waitFor(() => current.textContent().catch(() => ''), 'Error: Type mismatchsrc/handler.ts:2:3')
    expect(await panel.locator('.mb-message').textContent()).toBe('Type mismatch')
    expect(await panel.locator('[data-docked-count]').textContent()).toBe('1 error')

    const thrown = await report('Render failed')
    channel.setError(thrown)
    await waitFor(async () => (await calls()).messages[`my-bad:error:${thrown.id}`]?.message, 'Error: Render failed')
    expect((await calls()).messages[`my-bad:error:${thrown.id}`]).toMatchObject({ level: 'error' })
    expect((await calls()).messages[`my-bad:error:${thrown.id}`]?.notify).toBeUndefined()
    expect((await calls()).badges.at(-1)).toEqual({ badge: '2', badgeVariant: 'danger', title: 'my-bad (2 errors)' })
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Render failed')
    expect(await page.locator('my-bad-overlay').count()).toBe(0)

    await page.evaluate(() => (window as unknown as { devtools: { activate: (params: unknown) => void } }).devtools.activate({ source: 'ts' }))
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Type mismatch')
    await panel.locator('.mb-index-item', { hasText: 'Render failed' }).click()
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Render failed')

    channel.clearError()
    await waitFor(async () => (await calls()).removed.includes(`my-bad:error:${thrown.id}`), true)
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Type mismatch')
    const added = (await calls()).added.length
    channel.setProblems('ts', [typeError], { label: 'TypeScript', url: '/__typecheck/' })
    await page.waitForTimeout(200)
    expect((await calls()).added.length).toBe(added)
    expect(Object.keys((await calls()).messages)).toEqual(['my-bad:problems:ts'])

    channel.clearProblems()
    await waitFor(async () => Object.keys((await calls()).messages).length, 0)
    expect((await calls()).badges.at(-1)).toEqual({ badge: undefined, badgeVariant: 'warning', title: 'my-bad' })
    await waitFor(() => panel.locator('.mb-docked-empty-title').textContent().catch(() => ''), 'No problems')
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('leaves announcing new reports to the badge, raising no DevTools toast', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    const { page, errors, calls } = await open('/devtools-host')
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => page.evaluate(() => window.__MY_BAD_SOURCE__?.snapshot?.().problems[0]?.reports?.length), 1)
    channel.setProblems('ts', [await report('Type mismatch'), await report('Another mismatch')], { label: 'TypeScript' })
    await waitFor(async () => (await calls()).messages['my-bad:problems:ts']?.message, 'TypeScript: 2 errors')
    await waitFor(() => peek.isVisible(), true)
    expect(await peek.locator('.mb-peek-message').textContent()).toBe('Error: Another mismatch')

    const thrown = await report('Render failed')
    channel.setError(thrown)
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Render failed')
    await waitFor(async () => !!(await calls()).messages[`my-bad:error:${thrown.id}`], true)
    expect(Object.values((await calls()).messages).filter(message => message.notify !== undefined)).toEqual([])
    expect((await calls()).badges.at(-1)).toEqual({ badge: '3', badgeVariant: 'danger', title: 'my-bad (3 errors)' })

    channel.warn({
      ...await report('Careful now'),
      kind: 'warning',
    })
    await waitFor(() => peek.locator('.mb-peek-message').textContent(), 'Error: Careful now')
    await peek.click()
    await waitFor(() => page.frameLocator('iframe').locator('.mb-message').textContent().catch(() => ''), 'Careful now')
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('opens every badge entry in the my-bad dock, and a problem set\'s full list in the dock it names, or its url', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    const mismatch = await report('Type mismatch')
    channel.setProblems('ts', [mismatch], { label: 'TypeScript', url: '/__typecheck/', devtoolsDock: 'checker' })
    channel.setProblems('lint', [await report('Unused variable')], { label: 'ESLint', url: '/__lint/' })
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).messages['my-bad:problems:lint']?.actions?.at(-1)?.activate.dockId, 'my-bad')
    expect((await calls()).messages['my-bad:problems:lint']?.actions?.at(-1)?.activate).toEqual({
      dockId: 'my-bad',
      params: { source: 'lint', list: true },
    })

    const pills = page.locator('my-bad-overlay-badge .mb-problems')
    const panel = page.frameLocator('iframe')
    await pills.getByRole('button', { name: 'TypeScript 1' }).click()
    await waitFor(async () => (await calls()).switched.join(), 'my-bad')
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')

    await pills.getByRole('button', { name: 'ESLint 1' }).click()
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Unused variable')
    await panel.locator('[data-index-source="ts"]').getByRole('button', { name: 'Show the full list' }).click()
    await waitFor(async () => (await calls()).switched.at(-1), 'checker')
    expect(await panel.locator('.mb-docked-list').count()).toBe(0)

    await panel.locator('[data-index-source="lint"]').getByRole('button', { name: 'Show the full list' }).click()
    await waitFor(() => panel.locator('.mb-docked-list').getAttribute('src').catch(() => null), '/__lint/')
    await page.evaluate(() => (window as unknown as { devtools: { activate: (params: unknown) => void } }).devtools.activate({ source: 'ts' }))
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    await page.evaluate(() => (window as unknown as { devtools: { activate: (params: unknown) => void } }).devtools.activate({ source: 'lint', list: true }))
    await waitFor(() => panel.locator('.mb-docked-list').getAttribute('src').catch(() => null), '/__lint/')

    channel.setProblems('ts', [mismatch, await report('Missing property')], { label: 'TypeScript', url: '/__typecheck/', devtoolsDock: 'checker' })
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => peek.isVisible(), true)
    const switched = (await calls()).switched.length
    await peek.click()
    await waitFor(async () => (await calls()).switched.slice(switched).join(), 'my-bad')
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Missing property')
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('leaves the messages of a problem set to the dock it names, while still counting it', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('vue-tsc', [await report('Type mismatch')], { label: 'vue-tsc', devtoolsDock: 'checker' })
    channel.setProblems('lint', [await report('Unused variable')], { label: 'ESLint' })
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).badges.at(-1)?.badge, '2')
    await waitFor(async () => !!(await calls()).messages['my-bad:problems:lint'], true)
    expect(Object.keys((await calls()).messages)).toEqual(['my-bad:problems:lint'])
    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'vue-tsc 1' }).waitFor()

    channel.setProblems('vue-tsc', [], {
      label: 'vue-tsc',
      status: 'failed',
      error: 'crashed',
      devtoolsDock: 'checker',
    })
    channel.setProblems('lint', [await report('Unused variable'), await report('Unused import')], { label: 'ESLint' })
    await waitFor(async () => (await calls()).badges.at(-1)?.badge, '3')
    await waitFor(async () => (await calls()).messages['my-bad:problems:lint']?.message, 'ESLint: 2 errors')
    expect(new Set((await calls()).added)).toEqual(new Set(['my-bad:problems:lint']))
    channel.clearProblems()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('takes the colour scheme, colours and font of the DevTools panel it is docked in', async () => {
    channel.clearError()
    channel.clearProblems()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    await panel.locator('.mb-docked-title').waitFor()
    const root = () => panel.locator('html').evaluate((html) => {
      const style = getComputedStyle(html)
      return [
        html.dataset.theme,
        style.getPropertyValue('--mb-bg'),
        style.getPropertyValue('--mb-fg'),
        style.getPropertyValue('--mb-accent'),
        getComputedStyle(document.querySelector('.mb-root')!).fontFamily,
      ].join(' | ')
    })
    await waitFor(root, 'dark | rgb(17, 17, 17) | rgb(244, 244, 245) | #ff7a00 | Georgia')
    expect(await panel.locator('.mb-docked-title').textContent()).toBe('Problems')
    expect(await panel.locator('.mb-brand').count()).toBe(0)
    await page.evaluate(() => document.getElementById('host')!.classList.replace('dark', 'light'))
    await waitFor(async () => (await root()).split(' | ')[0], 'light')
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('keeps the theme of the embedding page out of the DevTools dock', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [], { label: 'TypeScript' })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel-themed`)
    const panel = page.frameLocator('iframe')
    await panel.locator('.mb-docked-title').waitFor()
    await waitFor(() => panel.locator('.mb-root').evaluate(el => getComputedStyle(el).fontFamily), 'Georgia')
    expect(await panel.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--mb-accent').trim())).not.toBe('#00ff00')
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('hides and shows the problems of a source from its pill', async () => {
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], {
      label: 'ESLint',
      lastRun: {
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      },
    })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const pill = panel.getByRole('button', { name: 'ESLint 1' })
    await pill.waitFor()
    expect(await pill.getAttribute('title')).toBe('Checked just now. Hide ESLint problems.')
    await pill.click()
    await waitFor(() => panel.locator('[data-index-source="lint"]').count(), 0)
    expect(await pill.getAttribute('aria-pressed')).toBe('false')
    expect(await pill.evaluate(button => button === document.activeElement)).toBe(true)
    expect(await panel.locator('[data-index-source="ts"]').count()).toBe(1)
    await page.keyboard.press('Enter')
    await waitFor(() => panel.locator('[data-index-source="lint"]').count(), 1)
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('clears the filter of the drawer with Escape before closing the drawer', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    const page = await browser.newPage()
    await page.goto(`${origin}/badge`)
    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' }).click()
    const drawer = page.locator('my-bad-overlay-badge .mb-drawer')
    const panel = page.frameLocator('my-bad-overlay-badge .mb-drawer iframe')
    const filter = panel.getByRole('searchbox', { name: 'Filter problems' })
    await filter.fill('no match')
    await panel.getByText('No problems match the current filters').waitFor()
    await filter.press('Escape')
    expect(await filter.inputValue()).toBe('')
    await waitFor(() => panel.locator('.mb-index-title').count(), 1)
    expect(await drawer.count()).toBe(1)
    await filter.press('Escape')
    await waitFor(() => drawer.count(), 0)
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('filters the list as you type, by level, and shows all again', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch'), await report('Missing property')], { label: 'TypeScript' })
    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], { label: 'ESLint' })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const titles = () => panel.locator('.mb-index-title').allTextContents()
    await waitFor(async () => (await titles()).length, 3)
    const filter = panel.getByRole('searchbox', { name: 'Filter problems' })
    await filter.pressSequentially('mis')
    await waitFor(async () => (await titles()).join(), 'Error: Type mismatch,Error: Missing property')
    channel.setError(await report('Render mismatch'))
    await waitFor(async () => (await titles()).join(), 'Error: Render mismatch,Error: Type mismatch,Error: Missing property')
    expect(await filter.evaluate(input => input === document.activeElement)).toBe(true)
    await filter.pressSequentially('sing')
    await waitFor(async () => (await titles()).join(), 'Error: Missing property')
    await page.keyboard.press('Escape')
    expect(await filter.inputValue()).toBe('')
    await waitFor(async () => (await titles()).length, 4)

    await panel.getByRole('button', { name: 'Errors 3' }).click()
    await waitFor(async () => (await titles()).join(), 'Error: Unused variable')
    await panel.getByRole('button', { name: 'Warnings 1' }).click()
    await panel.getByText('No problems match the current filters').waitFor()
    await panel.getByRole('button', { name: 'Show all' }).click()
    await waitFor(async () => (await titles()).length, 4)
    expect(await panel.getByRole('button', { name: 'Errors 3' }).getAttribute('aria-pressed')).toBe('true')
    expect(errors).toEqual([])
    channel.clearError()
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('groups the list by file, and remembers the choice', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], { label: 'ESLint' })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const headings = () => panel.locator('.mb-index-group h2 .mb-index-label').allTextContents()
    await waitFor(async () => (await headings()).join(), 'TypeScript,ESLint')
    await panel.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'File' }).click()
    await waitFor(async () => (await headings()).join(), `${proj}/src/handler.ts`)
    expect(await panel.locator('.mb-index-loc').allTextContents()).toEqual(['TypeScript · 2:3', 'ESLint · 2:3'])
    expect(await panel.locator(':focus').textContent()).toBe('File')
    await page.reload()
    await waitFor(async () => (await headings()).join(), `${proj}/src/handler.ts`)
    await panel.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Source' }).click()
    await waitFor(async () => (await headings()).join(), 'TypeScript,ESLint')
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('copies the problems listed as Markdown', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.warn({
      ...await report('Deprecated option'),
      kind: 'warning',
    })
    channel.setProblems('ts', [await report('Type mismatch'), await report('Missing property')], { label: 'TypeScript' })
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => Object.assign(window, { testClipboard: text }),
        },
      })
    })
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const copied = () => page.frames().find(frame => frame.url().includes('/panel'))!.evaluate(() => (window as Window & { testClipboard?: string }).testClipboard ?? '')
    await waitFor(async () => (await panel.locator('.mb-index-title').allTextContents()).length, 3)
    await panel.getByRole('button', { name: 'Copy the problems listed as Markdown' }).click()
    await waitFor(async () => (await copied()).match(/^## /gm)?.length, 3)
    expect(await copied()).toContain('## Warning: Error\n\n```\nDeprecated option\n```')
    await panel.getByRole('searchbox', { name: 'Filter problems' }).fill('missing')
    await waitFor(async () => (await panel.locator('.mb-index-title').allTextContents()).length, 1)
    await panel.getByRole('button', { name: /Copy the problems listed as Markdown|Copied problems/ }).click()
    await waitFor(async () => (await copied()).match(/^## /gm)?.length, 1)
    expect(await copied()).toContain('Missing property')
    channel.clearWarning()
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('follows what each source is doing while nothing is open, and lists problems once they arrive', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [], { label: 'TypeScript', status: 'checking' })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const title = () => panel.locator('.mb-docked-empty-title').textContent().catch(() => '')
    const status = () => panel.locator('.mb-watched-status').allTextContents()
    await waitFor(title, 'Checking for problems')
    expect(await status()).toEqual(['Starting'])
    channel.setProblems('ts', [], {
      label: 'TypeScript',
      lastRun: {
        startedAt: Date.now() - 2000,
        finishedAt: Date.now(),
      },
    })
    await waitFor(title, 'No problems')
    expect(await status()).toEqual(['No problems, checked just now'])
    expect(await panel.locator('[data-filter]').count()).toBe(0)
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    expect(await panel.locator('[data-filter]').count()).toBe(1)
    channel.setProblems('ts', [], { label: 'TypeScript', status: 'failed', error: 'Checker crashed' })
    await waitFor(async () => (await status()).join(), 'Failed: Checker crashed')
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('follows the status of the source in focus while it has nothing to show', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    channel.setProblems('vue', [], { label: 'Vue', status: 'failed', error: 'Checker crashed' })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    await panel.locator('.mb-message').waitFor()
    await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'my-bad:select', source: 'vue' }, location.origin))
    const status = () => panel.locator('[data-unselected]').textContent().catch(() => '')
    await waitFor(status, 'VueFailed: Checker crashed')
    channel.setProblems('vue', [], { label: 'Vue' })
    await waitFor(status, 'VueNo problems')
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('marks the selected row in its severity colour, not the accent', async () => {
    channel.clearError()
    channel.clearProblems()
    channel.setProblems('lint', [
      {
        ...await report('Unused variable'),
        kind: 'warning',
      },
    ], { label: 'ESLint' })
    const page = await browser.newPage()
    await page.goto(`${origin}/devtools-panel`)
    const panel = page.frameLocator('iframe')
    const selected = panel.locator('.mb-index-item[aria-current="true"]')
    await selected.waitFor()
    const colours = await selected.evaluate((item) => {
      const style = getComputedStyle(item)
      const probe = document.createElement('span')
      item.append(probe)
      probe.style.backgroundColor = 'var(--mb-accent-soft)'
      const accent = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        bar: style.boxShadow,
        icon: getComputedStyle(item.querySelector('svg')!).color,
        background: style.backgroundColor,
        accent,
      }
    })
    expect(colours.bar).toContain(colours.icon)
    expect(colours.background).not.toBe(colours.accent)
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('heads DevTools messages with the first line, without the backticks of code spans', async () => {
    channel.clearError()
    channel.clearProblems()
    const current = {
      ...await report('Use `Widget`'),
      message: '\nUse `Widget`\n\n - `props` is unused',
      hint: 'Remove the `import`.',
      codeSpans: true,
    }
    channel.setError(current)
    channel.setProblems('vue', [current], { label: 'Vue' })
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).messages[`my-bad:error:${current.id}`]?.message, 'Error: Use Widget')
    expect((await calls()).messages[`my-bad:error:${current.id}`]?.description).toBe(' - props is unused\n\nRemove the import.')
    await waitFor(async () => (await calls()).messages['my-bad:problems:vue']?.description, 'src/handler.ts:2  Use Widget')
    expect(errors).toEqual([])
    channel.clearError()
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('marks a problem set message as loading while it is checked', async () => {
    channel.clearError()
    channel.clearProblems()
    const reports = [await report('Type mismatch')]
    channel.setProblems('ts', reports, { label: 'TypeScript' })
    const { page, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).messages['my-bad:problems:ts']?.status, 'idle')
    channel.setProblems('ts', reports, { label: 'TypeScript', status: 'checking' })
    await waitFor(async () => (await calls()).messages['my-bad:problems:ts']?.status, 'loading')
    channel.setProblems('ts', reports, { label: 'TypeScript', status: 'idle' })
    await waitFor(async () => (await calls()).messages['my-bad:problems:ts']?.status, 'idle')
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('mounts the badge itself on a page that renders none, and opens the dock from it', async () => {
    channel.clearWarning()
    channel.clearError()
    channel.clearProblems()
    const { page, errors, calls } = await open('/devtools-host-bare')
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.host), true)
    channel.setError(await report('Injected badge error'))
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => peek.isVisible(), true)
    await peek.click()
    expect((await calls()).switched).toEqual(['my-bad'])
    await waitFor(() => page.frameLocator('iframe').locator('.mb-message').textContent().catch(() => ''), 'Injected badge error')
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    expect(await page.locator('my-bad-overlay-badge').count()).toBe(1)
    channel.clearError()
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('lists warnings, and moves on when the one shown is retired', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    const earlier = {
      ...await report('Earlier warning'),
      kind: 'warning' as const,
    }
    const latest = {
      ...await report('Latest warning'),
      kind: 'warning' as const,
    }
    channel.warn(earlier)
    channel.warn(latest)
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).badges.at(-1)?.badge, '2')
    expect((await calls()).badges.at(-1)).toEqual({ badge: '2', badgeVariant: 'warning', title: 'my-bad (2 warnings)' })
    expect((await calls()).messages).toEqual({})
    await page.locator('my-bad-overlay-badge .mb-badge').click()
    const panel = page.frameLocator('iframe')
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Latest warning')
    await panel.locator('.mb-index-item', { hasText: 'Earlier warning' }).click()
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Earlier warning')
    channel.clearWarning(earlier.id)
    await waitFor(() => panel.locator('.mb-message').textContent(), 'Latest warning')
    await waitFor(() => panel.locator('[data-docked-count]').textContent(), '1 warning')
    channel.clearWarning(latest.id)
    await waitFor(() => panel.locator('.mb-docked-empty-title').textContent().catch(() => ''), 'No problems')
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('mounts the overlay for an error without waiting when no dock is registered', async () => {
    channel.clearError()
    channel.clearProblems()
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/badge-await-long`)
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.snapshot?.().ready), true)
    channel.setError(await report('No dock'))
    await waitFor(() => page.locator('my-bad-overlay').count(), 1)
    channel.clearError()
    await page.close()
  }, 30_000)

  it('waits for a host before mounting the overlay for an error, and mounts it when none takes over', async () => {
    channel.clearError()
    channel.clearProblems()
    channel.setDevTools(true)
    onTestFinished(() => channel.setDevTools(false))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/badge-await`)
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.snapshot?.().ready), true)
    channel.setError(await report('Late host'))
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-peek').isVisible(), true)
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    await waitFor(() => page.locator('my-bad-overlay').count(), 1)
    await page.addScriptTag({ type: 'module', content: `${devtoolsHost}await setup(ctx)` })
    await waitFor(() => page.locator('my-bad-overlay').count(), 0)
    channel.setError(await report('After the host'))
    await page.locator('my-bad-overlay-badge .mb-peek').click()
    await waitFor(() => page.frameLocator('iframe').locator('.mb-message').textContent().catch(() => ''), 'After the host')
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    channel.clearError()
    await page.close()
  }, 30_000)

  it('hands an error to a host that starts while the badge waits for one', async () => {
    channel.clearError()
    channel.clearProblems()
    channel.setDevTools(true)
    onTestFinished(() => channel.setDevTools(false))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    await page.goto(`${origin}/badge-await`)
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.snapshot?.().ready), true)
    channel.setError(await report('Taken over'))
    await waitFor(() => page.locator('my-bad-overlay-badge .mb-peek').isVisible(), true)
    await page.addScriptTag({ type: 'module', content: `${devtoolsHost}await setup(ctx)` })
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.host), true)
    await page.waitForTimeout(1800)
    expect(await page.locator('my-bad-overlay').count()).toBe(0)
    await page.locator('my-bad-overlay-badge .mb-peek').click()
    await waitFor(() => page.frameLocator('iframe').locator('.mb-message').textContent().catch(() => ''), 'Taken over')
    channel.clearError()
    await page.close()
  }, 30_000)

  it('follows an empty problem set that it shows once reports arrive', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [], { label: 'TypeScript', status: 'failed', error: 'Checker crashed' })
    const { page, errors, calls } = await open('/devtools-host')
    await waitFor(async () => (await calls()).badges.at(-1)?.badgeVariant, 'danger')
    await page.locator('my-bad-overlay-badge .mb-problems button').first().click()
    const panel = page.frameLocator('iframe')
    await waitFor(() => panel.locator('[data-docked-count]').textContent().catch(() => ''), '1 check failed')
    expect(await panel.locator('.mb-docked-empty-title').textContent()).toBe('A check failed')
    await waitFor(() => panel.locator('.mb-message').count(), 0)
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    channel.setProblems('ts', [], { label: 'TypeScript', status: 'idle' })
    await waitFor(() => panel.locator('.mb-docked-empty-title').textContent().catch(() => ''), 'No problems')
    await waitFor(async () => Object.keys((await calls()).messages).length, 0)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('dismisses an overlay whose script loads after the host took over', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setError(await report('Raced the host'))
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let requested: () => void
    const overlayRequested = new Promise<void>(resolve => requested = resolve)
    await page.route('**/__my-bad/devtools.js*', async (route) => {
      await overlayRequested
      await route.continue()
    })
    await page.route('**/__my-bad/client.js*', async (route) => {
      requested()
      await page.waitForFunction(() => window.__MY_BAD_SOURCE__?.host)
      await route.continue()
    })
    await page.goto(`${origin}/devtools-host`)
    await page.locator('my-bad-overlay-badge .mb-badge').waitFor({ timeout: 5000 })
    await waitFor(() => page.locator('my-bad-overlay').count(), 0)
    expect(errors).toEqual([])
    channel.clearError()
    await page.close()
  }, 30_000)

  it('connects a docked page framed by another origin', async () => {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const streams = { opened: 0 }
      Object.assign(window, { streams })
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          streams.opened++
        }
      }
    })
    await page.route('http://embedder.test/', route => route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html lang="en"><title>Embedder</title><iframe src="http://panel.test/__my-bad/panel?embed"></iframe></html>' }))
    await page.route('http://panel.test/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/events')) {
        return route.abort()
      }
      const res = await fetch(`${origin}${url.pathname}${url.search}`)
      await route.fulfill({
        status: res.status,
        contentType: res.headers.get('content-type') ?? undefined,
        body: await res.text(),
      })
    })
    await page.goto('http://embedder.test/')
    const opened = () => page.frames().find(frame => frame.url().startsWith('http://panel.test/'))?.evaluate(() => (window as unknown as { streams: { opened: number } }).streams.opened).catch(() => 0)
    await waitFor(opened, 1)
    expect(errors).toEqual([])
    await page.close()
  }, 30_000)

  it('shows only the errors in scope of the embedding page', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    const mine = await report('Host request failed')
    const other = await report('Different request failed')
    channel.setError(other, undefined, 'GET /different-page')
    channel.setError(mine, undefined, 'GET /devtools-host')
    const { page, errors } = await open('/devtools-host')
    await page.locator('my-bad-overlay-badge .mb-badge').click()
    const panel = page.frameLocator('iframe')
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Host request failed')
    await waitFor(() => panel.locator('[data-docked-count]').textContent(), '1 error')
    expect(await panel.locator('.mb-index-item', { hasText: 'Different request failed' }).count()).toBe(0)
    expect(errors).toEqual([])
    channel.clearError()
    await page.close()
  }, 30_000)
})

describe('content security policy', () => {
  async function load(path: string) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.assign(window, { violations })
      addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective), true)
    })
    await page.goto(`${origin}${path}`)
    const violations = () => page.evaluate(() => (window as unknown as { violations: string[] }).violations)
    return { page, errors, violations }
  }

  it('hydrates a page and an overlay rendered with the page\'s nonce', async () => {
    channel.clearError()
    channel.setError(await report('under policy'))

    const { page, errors, violations } = await load('/csp-page?nonce')
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_CLIENT__), true)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toMatch(/^(?:light|dark)$/)
    expect(await page.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')
    expect(await violations()).toEqual([])

    await page.goto(`${origin}/csp-overlay?nonce`)
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'under policy')
    expect(await overlay.locator('.mb-header').evaluate(el => getComputedStyle(el).display)).toBe('flex')
    expect(await violations()).toEqual([])
    expect(errors).toEqual([])
    channel.clearError()
    await page.close()
  }, 30_000)

  it('mounts the badge, and the overlay it loads, with the page\'s nonce', async () => {
    channel.clearError()
    channel.clearWarning()
    const { page, errors, violations } = await load('/csp-badge?nonce')
    channel.warn({
      ...(await report('careful')),
      kind: 'warning',
    })
    const dock = page.locator('my-bad-overlay-badge .mb-dock')
    await waitFor(() => dock.evaluate(el => getComputedStyle(el).position).catch(() => ''), 'fixed')

    channel.setError(await report('loaded by the badge'))
    const overlay = page.locator('my-bad-overlay')
    await waitFor(() => overlay.locator('[data-message]').first().textContent(), 'loaded by the badge')
    expect(await overlay.locator('[data-overlay]').evaluate(el => getComputedStyle(el).position)).toBe('fixed')
    expect(await violations()).toEqual([])
    expect(errors).toEqual([])
    channel.clearError()
    channel.clearWarning()
    await page.close()
  }, 30_000)

  it('opens the drawer in a docked page served with the nonce, which adopts the theme of the page', async () => {
    channel.clearError()
    channel.clearWarning()
    channel.clearProblems()
    channel.setProblems('ts', [await report('Type mismatch')], { label: 'TypeScript' })
    const { page, errors, violations } = await load('/csp-drawer?nonce')
    await page.locator('my-bad-overlay-badge .mb-problems').getByRole('button', { name: 'TypeScript 1' }).click()
    const panel = page.frameLocator('my-bad-overlay-badge .mb-drawer iframe')
    await waitFor(() => panel.locator('.mb-message').textContent().catch(() => ''), 'Type mismatch')
    await waitFor(() => panel.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--mb-csp')), 'adopted')
    const frame = page.frames().find(frame => frame.url().includes('/__csp-channel/panel'))!
    expect(await frame.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([])
    expect(await violations()).toEqual([])
    expect(errors).toEqual([])
    channel.clearProblems()
    await page.close()
  }, 30_000)

  it('mounts the badge from the DevTools client with the nonce Vite publishes', async () => {
    channel.clearError()
    const { page, errors, violations } = await load('/csp-devtools?nonce')
    await waitFor(() => page.evaluate(() => !!window.__MY_BAD_SOURCE__?.host), true)
    channel.setError(await report('through devtools'))
    const peek = page.locator('my-bad-overlay-badge .mb-peek')
    await waitFor(() => peek.isVisible(), true)
    expect(await page.locator('my-bad-overlay-badge .mb-dock').evaluate(el => getComputedStyle(el).position)).toBe('fixed')
    expect(await violations()).toEqual([])
    expect(errors).toEqual([])
    channel.clearError()
    await page.close()
  }, 30_000)

  it('is blocked by the policy without the nonce', async () => {
    for (const path of ['/csp-page', '/csp-badge']) {
      const { page, violations } = await load(path)
      await waitFor(async () => (await violations()).includes('script-src-elem'), true)
      await page.close()
    }
  }, 30_000)
})

import type { Browser } from 'playwright'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientAssets, createReport, renderOverlay, renderPage } from '../src'
import { createChannel } from '../src/channel'

let browser: Browser
let close: () => void
let origin: string
const openRequests: unknown[] = []
const channel = createChannel({ open: request => void openRequests.push(request), root: '/proj' })
const assets = { script: '/client.js', styles: '/client.css' }

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

async function report(message: string) {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at handler (/proj/src/handler.ts:2:3)\n    at dep (/proj/node_modules/dep/index.js:1:1)`
  return createReport(error, { cwd: '/proj', loaders: [{ name: 'memory', read: () => 'line1\nthrow new Error()\nline3\n' }] })
}

beforeAll(async () => {
  browser = await chromium.launch()
  const server = createServer(async (req, res) => {
    if (await channel.handler(req, res)) {
      return
    }
    if (req.url === '/client.js' || req.url === '/client.css') {
      res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css')
      res.end(req.url.endsWith('.js') ? clientAssets.script : clientAssets.styles)
      return
    }
    const current = channel.current ?? await report('initial')
    res.setHeader('content-type', 'text/html')
    if (req.url === '/overlay-external') {
      res.end(`<!DOCTYPE html><html><body>${renderOverlay(current, { cwd: '/proj', assets })}</body></html>`)
      return
    }
    if (req.url === '/page-external') {
      res.end(renderPage(current, { cwd: '/proj', assets }))
      return
    }
    if (req.url === '/blank') {
      res.end('<!DOCTYPE html><html><body><h1 id="user">User error page</h1></body></html>')
      return
    }
    if (req.url === '/fragment-external') {
      res.setHeader('content-type', 'text/plain')
      res.end(renderOverlay(current, { cwd: '/proj', assets }))
      return
    }
    if (req.url === '/overlay-minimized') {
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: '/proj', channel: '/__my-bad', startMinimized: true })}</body></html>`)
      return
    }
    if (req.url === '/overlay') {
      res.end(`<!DOCTYPE html><html><body><h1 id="user">User error page</h1>${renderOverlay(current, { cwd: '/proj', channel: '/__my-bad' })}</body></html>`)
      return
    }
    res.end(renderPage(current, { cwd: '/proj', channel: '/__my-bad', history: channel.history }))
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

    channel.warn({ ...(await report('careful')), kind: 'warning' })
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

  it('shows the build progress label below the bar, clear of the header', async () => {
    for (const path of ['/', '/overlay']) {
      channel.setError(await report(`progress ${path}`))
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
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
    await overlay.locator('[data-overlay]').click({ position: { x: 60, y: 60 } })
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
    await overlay.locator('[data-overlay]').click({ position: { x: 60, y: 60 } })
    await waitFor(() => overlay.locator('[data-overlay]').getAttribute('data-minimized'), null)
    await preview.locator('[data-action="minimize"]').click()
    await overlay.locator('[data-action="hide"]').click()
    await waitFor(() => overlay.locator('[data-action="restore"]').isVisible(), true)
    channel.clearError()
    await waitFor(() => page.locator('my-bad-overlay').count(), 0)
    await page.close()
  }, 30_000)

  it('keeps a startMinimized overlay minimised whatever the user last chose', async () => {
    channel.setError(await report('always minimized'))
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
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

  it('mounts and styles itself when the script and stylesheet are served separately', async () => {
    channel.setError(await report('external'))
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
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

describe('source-first inspection', () => {
  it('keeps source in place, scopes context and compiled views, and reveals supporting evidence', async () => {
    const current = await report('Cannot save this widget')
    current.frames[0]!.line = 6
    current.frames[0]!.snippet = { start: 1, lines: Array.from({ length: 11 }, (_, i) => `const line${i + 1} = ${i + 1}`) }
    current.frames[0]!.compiled = { file: '/proj/dist/handler.js', line: 20, column: 9, snippet: { start: 20, lines: ['throw Error()'] } }
    current.frames.splice(1, 0, { type: 'app', file: '/proj/caller.ts', function: 'caller', line: 2, snippet: { start: 1, lines: ['start()', 'handler()', 'finish()'] } })
    current.causes = [{ ...current, id: 'inner', message: 'Missing name', frames: [], causes: [] }]
    current.trace = [{ label: '<Widget>' }]
    channel.setError(current)
    for (const path of ['/', '/overlay']) {
      const page = await browser.newPage()
      await page.goto(`${origin}${path}`)
      const root = page.locator('[data-my-bad-root]')
      await waitFor(() => root.locator('[data-live][data-connected]').count(), 1)
      const source = root.locator('.mb-source').first()
      const stack = root.locator('[data-stack]').first()
      expect(await root.locator('h1').textContent()).toBe(current.message)
      expect(await source.locator('.mb-line:not(.mb-line-caret):visible').count()).toBe(7)
      await source.getByRole('button', { name: 'More context', exact: true }).click()
      expect(await source.locator('.mb-line:not(.mb-line-caret):visible').count()).toBe(11)
      await source.getByRole('button', { name: 'Less context', exact: true }).click()
      await source.locator('[data-switch="compiled"]').click()
      expect(await source.locator('[data-snippet-compiled]').isVisible()).toBe(true)
      const requests = openRequests.length
      await source.locator('[data-location-compiled] [data-loc]').click()
      await waitFor(() => openRequests.length, requests + 1)
      expect(openRequests.at(-1)).toEqual({ file: '/proj/src/handler.ts', line: 6, column: 3 })
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
      expect(await caller.locator('[data-frame-body]').isVisible()).toBe(true)
      const callerRequests = openRequests.length
      await caller.locator('[data-loc]').focus()
      await page.keyboard.press('Enter')
      await waitFor(() => openRequests.length, callerRequests + 1)
      expect(openRequests.at(-1)).toEqual({ file: '/proj/caller.ts', line: 2 })
      expect(await source.boundingBox()).toEqual(before)
      expect(await root.getByRole('region', { name: 'Error source', exact: true }).count()).toBe(1)
      expect(await stack.locator('.mb-framework-hidden').isVisible()).toBe(true)
      expect(await stack.locator('[data-frame-type="vendor"]').isVisible()).toBe(false)
      await stack.getByRole('switch').click()
      expect(await stack.locator('[data-frame-type="vendor"]').first().isVisible()).toBe(true)
      expect(await stack.locator('.mb-framework-hidden').isVisible()).toBe(false)
      await stack.locator('[data-action="stack"]').click()
      expect(await caller.locator('[data-frame-body]').isVisible()).toBe(false)
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
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => Object.assign(window, { testClipboard: text }) } })
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
})

describe('accessibility', () => {
  it('has labelled controls, landmarks and keyboard navigation', async () => {
    channel.setError(await report('a11y'))
    const page = await browser.newPage()
    await page.goto(origin)
    await waitFor(() => page.locator('[data-message]').first().textContent(), 'a11y')

    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('button')].filter(button => !button.textContent?.trim() && !button.getAttribute('aria-label')).map(button => button.outerHTML.slice(0, 80)))
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
    expect(openRequests.at(-1)).toEqual({ file: '/proj/src/handler.ts', line: 2, column: 3 })
    await page.close()
  }, 30_000)
})

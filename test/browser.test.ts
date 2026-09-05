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
const channel = createChannel({ open: request => void openRequests.push(request) })
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

    await page.click('[data-action="logs"]')
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
    const closedFrame = page.locator('[data-frame][data-has-snippet]').filter({ has: page.locator('[data-frame-body]:not([open])') }).first()
    if (await closedFrame.count()) {
      await closedFrame.locator('[data-switch="compiled"], [data-switch="source"]').first().click()
      expect(await closedFrame.locator('[data-frame-body]').evaluate(el => (el as HTMLDetailsElement).open)).toBe(true)
    }
    await page.locator('.mb-loc').first().click()
    await waitFor(() => openRequests.length, 1)
    expect(openRequests[0]).toEqual({ file: '/proj/src/handler.ts', line: 2, column: 3 })
    await page.close()
  }, 30_000)
})

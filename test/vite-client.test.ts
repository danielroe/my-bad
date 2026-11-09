import type { ServerResponse } from 'node:http'
import type { Browser } from 'playwright'
import type { Plugin, ViteDevServer } from 'vite'
import type { DevToolsPlugin } from '../src/vite/devtools'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { myBad, useMyBad } from '../src/vite'

const root = fileURLToPath(new URL('./fixtures/vite-client/', import.meta.url)).replace(/\/$/, '')

let browser: Browser
let server: ViteDevServer
let origin: string

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      myBad(),
    ],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function settle(ms = 400): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('vite client', () => {
  it('updates the mounted overlay instead of mounting another per error', async () => {
    const ctx = useMyBad(server)!
    const page = await browser.newPage()
    const message = () => page.locator('my-bad-overlay [data-message]').first().textContent()
    await page.goto(origin)
    await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'ready')
    await settle()
    const connected = ctx.channel.clients

    await ctx.emit(new Error('first'))
    await settle()
    expect(await message()).toBe('first')

    await ctx.emit(new Error('second'))
    await settle()
    expect(await message()).toBe('second')
    expect(await page.locator('my-bad-overlay').count()).toBe(1)
    expect(ctx.channel.clients).toBe(connected + 1)

    ctx.clear()
    await settle()
    expect(await page.locator('my-bad-overlay').count()).toBe(0)

    await ctx.emit(new Error('after the clear'))
    await settle()
    expect(await message()).toBe('after the clear')
    expect(await page.locator('my-bad-overlay').count()).toBe(1)
    expect(ctx.channel.clients).toBe(connected + 1)
    await page.close()
  }, 60_000)

  describe('with a DevTools dock', () => {
    let docked: ViteDevServer
    let url: string

    beforeAll(async () => {
      const plugin = myBad() as DevToolsPlugin
      plugin.devtools!.setup({
        docks: {
          register: () => {},
        },
      })
      docked = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      })
      await docked.listen()
      url = `http://127.0.0.1:${(docked.httpServer!.address() as { port: number }).port}`
    }, 60_000)

    afterAll(() => docked?.close())

    async function load() {
      const page = await browser.newPage()
      await page.goto(url)
      await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'ready')
      await settle()
      return page
    }

    it('leaves the error to DevTools once its client takes over the badge', async () => {
      const ctx = useMyBad(docked)!
      const page = await load()
      await ctx.emit(new Error('hosted'))
      await settle()
      await page.evaluate(() => {
        window.__MY_BAD_SOURCE__ = Object.assign(new EventTarget(), {
          url: '',
          close: () => {},
          host: {
            open: () => {},
          },
        })
        dispatchEvent(new Event('my-bad:host'))
      })
      await settle(3500)
      expect(await page.locator('my-bad-overlay').count()).toBe(0)
      ctx.clear()
      await page.close()
    }, 60_000)

    it('mounts the latest error when no client takes over, skipping one cleared while it waited', async () => {
      const ctx = useMyBad(docked)!
      const page = await load()
      await ctx.emit(new Error('cleared while waiting'))
      ctx.clear()
      await ctx.emit(new Error('latest'))
      await settle()
      expect(await page.locator('my-bad-overlay').count()).toBe(0)
      await page.locator('my-bad-overlay [data-message]').first().waitFor({ timeout: 5000 })
      expect(await page.locator('my-bad-overlay [data-message]').first().textContent()).toBe('latest')
      expect(await page.locator('my-bad-overlay').count()).toBe(1)
      ctx.clear()
      await settle()
      await ctx.emit(new Error('after the wait'))
      await settle()
      expect(await page.locator('my-bad-overlay [data-message]').first().textContent()).toBe('after the wait')
      ctx.clear()
      await page.close()
    }, 60_000)
  })
})

describe('vite client under a content security policy', () => {
  const placeholder = 'vite-placeholder'
  const nonce = 'page-nonce-00001'
  let secured: ViteDevServer
  let url: string

  beforeAll(async () => {
    const perRequestNonce: Plugin = {
      name: 'per-request-nonce',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/') {
            res.setHeader('content-security-policy', `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`)
            const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse
            res.end = ((chunk: unknown, ...rest: unknown[]) => end(typeof chunk === 'string' || Buffer.isBuffer(chunk)
              ? String(chunk).replaceAll(placeholder, nonce)
              : chunk, ...rest)) as typeof res.end
          }
          next()
        })
      },
    }
    secured = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      html: { cspNonce: placeholder },
      plugins: [
        perRequestNonce,
        myBad(),
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await secured.listen()
    url = `http://127.0.0.1:${(secured.httpServer!.address() as { port: number }).port}/`
  }, 60_000)

  afterAll(() => secured?.close())

  it('mounts the overlay with the nonce of the page, not the one in the config', async () => {
    const ctx = useMyBad(secured)!
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.assign(window, { violations })
      addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective), true)
    })
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('#app')?.textContent === 'ready')
    await settle()

    await ctx.emit(new Error('under policy'))
    const overlay = page.locator('my-bad-overlay')
    await overlay.locator('[data-message]').first().waitFor({ timeout: 5000 })
    expect(await overlay.locator('[data-overlay]').evaluate(el => getComputedStyle(el).position)).toBe('fixed')
    expect(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([])
    expect(errors).toEqual([])
    ctx.clear()
    await page.close()
  }, 60_000)
})

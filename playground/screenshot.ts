import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { renderOverlay, renderPage } from '../dist/index.mjs'
import { nuxtTheme } from '../dist/presets/index.mjs'
import { demoReport, fixtures } from './demo.ts'

const out = fileURLToPath(new URL('./out/', import.meta.url))

await mkdir(out, { recursive: true })
const report = await demoReport()

const theme = process.argv.includes('--neutral') ? { name: 'my-bad' } : nuxtTheme
const page = renderPage(report, { cwd: fixtures, channel: '/__my-bad', theme })
await writeFile(`${out}page.html`, page)
const http = renderPage({ ...report, name: 'HTTPError', status: 500, message: 'Internal server error' }, { cwd: fixtures, channel: '/__my-bad', theme })
await writeFile(`${out}http.html`, http)

const host = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;padding:40px;background:#f5f5f5}</style></head><body><h1>User error.vue page</h1><p>Some user content here.</p>${renderOverlay(report, { cwd: fixtures, theme, startMinimized: process.argv.includes('--minimized') })}</body></html>`
await writeFile(`${out}overlay.html`, host)

const browser = await chromium.launch()
for (const [name, scheme] of [['page-light', 'light'], ['page-dark', 'dark'], ['http-dark', 'dark'], ['overlay', 'light']] as const) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme })
  const p = await ctx.newPage()
  p.on('pageerror', err => console.error('pageerror', err))
  await p.goto(`file://${out}${name.split('-')[0]}.html`)
  await p.waitForTimeout(200)
  await p.screenshot({ path: `${out}${name}.png` })
  if (name === 'overlay') {
    await p.click('my-bad-overlay >> [data-preview] [data-action="minimize"]').catch(e => console.error(e.message))
    await p.waitForTimeout(400)
    await p.screenshot({ path: `${out}overlay-minimized.png` })
  }
  await ctx.close()
}
await browser.close()
console.log('done')

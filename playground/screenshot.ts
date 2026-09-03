import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { createReport, renderOverlay, renderPage } from '../dist/index.mjs'
import { nuxtTheme } from '../dist/presets/index.mjs'

const fixtures = fileURLToPath(new URL('../test/fixtures/basic/', import.meta.url))
const out = fileURLToPath(new URL('./out/', import.meta.url))

async function fixtureError(fn: string): Promise<Error> {
  const { stdout } = await promisify(execFile)(process.execPath, [`${fixtures}run.mjs`, 'sidecar', fn])
  const revive = (data: any): Error => {
    const error = new Error(data.message, data.cause ? { cause: revive(data.cause) } : undefined)
    error.name = data.name
    error.stack = data.stack
    return error
  }
  return revive(JSON.parse(stdout))
}

await mkdir(out, { recursive: true })
const report = await createReport(await fixtureError('withCause'), { cwd: fixtures })
report.code = 'E1001'
report.docsUrl = 'https://nuxt.com/docs/errors/e1001'
report.hint = 'The widget factory received an empty name. Check the `name` prop passed from the parent component.'
report.trace = [{ label: '<App>', file: `${fixtures}src/app.vue` }, { label: '<NuxtLayout>' }, { label: '<WidgetList>', file: `${fixtures}src/widget-list.vue`, line: 12 }]
report.sections.push({ id: 'request', title: 'Request', content: { 'method': 'GET', 'url': '/widgets?page=2', 'user-agent': 'Mozilla/5.0' } })

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

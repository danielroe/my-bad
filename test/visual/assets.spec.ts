import { expect, test } from 'playwright/test'
import { clientAssets, renderAnsi, renderBadge, renderPage } from '../../dist/index.mjs'
import { ansiSvg } from '../../playground/ansi-svg.ts'
import { demoReport, fixtures } from '../../playground/demo.ts'

/**
 * Imports the built package because this spec runs under Playwright's runner,
 * which has no bundler to resolve the inlined client module.
 *
 * Renders the README assets as snapshots, so a run only rewrites a file when the
 * rendering really moved: the default `threshold` already discards antialiasing
 * differences per pixel, and `maxDiffPixels` then absorbs a few hundred of them
 * from a Chromium bump. For scale, on these 2400x1520 renders an accent colour
 * change counts ~4.4k differing pixels and a base font size change ~24k.
 */
test.describe('README assets', () => {
  test('error page', async ({ page }) => {
    const report = await demoReport()
    const html = renderPage(report, { cwd: fixtures, channel: '/__my-bad', theme: { name: 'my-bad' } })
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setContent(html)
      await expect(page).toHaveScreenshot(`page-${scheme}.png`, { maxDiffPixels: 2000, scale: 'device', animations: 'disabled', caret: 'hide' })
    }
  })

  test('badge', async ({ page }) => {
    const history = [
      { id: 'a', kind: 'warning', name: 'Vue warn', message: 'Invalid prop: type check failed for prop "count"', timestamp: 0 },
      { id: 'b', kind: 'warning', name: 'NUXT_B4025', message: '<NuxtLink> has both `to` and `href`', timestamp: 0 },
    ]
    const latest = { ...history[1], frames: [], causes: [], sections: [] }
    const events = `event: hello\ndata: ${JSON.stringify({ version: '0', actions: [], history: history.slice(0, 1) })}\n\nevent: warning\ndata: ${JSON.stringify({ report: latest, history })}\n\n`
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>html{color-scheme:light dark}body{margin:0;background:Canvas}</style>${renderBadge({ channel: '/__my-bad' })}</head><body></body></html>`
    await page.route('http://my-bad.test/**', (route) => {
      const url = route.request().url()
      if (url.includes('/__my-bad/events')) {
        return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: events })
      }
      if (url.includes('/__my-bad/badge.js')) {
        return route.fulfill({ contentType: 'text/javascript', body: clientAssets.badge })
      }
      return route.fulfill({ contentType: 'text/html', body: html })
    })
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto('http://my-bad.test/')
      await page.locator('.mb-badge-latest:not(:empty)').waitFor()
      const box = (await page.locator('.mb-badge').boundingBox())!
      const clip = { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 }
      await expect(page).toHaveScreenshot(`badge-${scheme}.png`, { clip, maxDiffPixels: 200, scale: 'device', animations: 'disabled', caret: 'hide' })
    }
  })

  test('terminal output', async () => {
    const report = await demoReport()
    const svg = await ansiSvg(renderAnsi(report, { cwd: fixtures, colors: true, hyperlinks: false, width: 96 }))
    expect(svg).toMatchSnapshot('ansi.svg')
  })
})

import { expect, test } from 'playwright/test'
import { renderAnsi, renderPage } from '../../dist/index.mjs'
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

  test('terminal output', async () => {
    const report = await demoReport()
    const svg = await ansiSvg(renderAnsi(report, { cwd: fixtures, colors: true, hyperlinks: false, width: 96 }))
    expect(svg).toMatchSnapshot('ansi.svg')
  })
})

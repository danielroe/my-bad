import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { renderPage } from '../../dist/index.mjs'

const origin = process.env.REVIEW_ORIGIN || 'http://127.0.0.1:4330'
const output = fileURLToPath(new URL('./public/review/', import.meta.url))
await mkdir(output, { recursive: true })
const raw = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : await (await fetch(`${origin}/__lab/state`)).json()
// Keep the actual reports and source coordinates, without publishing local home paths.
const frozen = JSON.parse(JSON.stringify(raw).replaceAll(raw.cwd, '/project/employee-directory').replaceAll(/\/Users\/[^/]+\/Dev\/my-bad/g, '/project/my-bad'))
const all = [...frozen.reports, ...frozen.archived]
const client = all.find(item => item.report.name === 'TypeError' && item.environment === 'Client')
const cause = all.find(item => item.report.message === 'Could not restore the employee directory')
if (!client || !cause)
  throw new Error('Run the missing-profile and nested-cause scenarios first so both real reports are in history.')
const compact = frozen.sourceExamples?.compact
if (!compact)
  throw new Error('Capture the save-employee wrapper error for the compact source example first.')
const logs = frozen.logs.slice(-40)
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' })
await context.addInitScript(({ logs }) => {
  // Freeze transport only: both screens still use their real renderers and interactions.
  window.EventSource = class extends EventTarget {
    constructor() {
      super()
      setTimeout(() => {
        this.onopen?.(new Event('open'))
        this.dispatchEvent(new Event('open'))
        this.dispatchEvent(new MessageEvent('hello', { data: JSON.stringify({ actions: [], history: [] }) }))
        for (const log of logs)
          this.dispatchEvent(new MessageEvent('log', { data: JSON.stringify(log) }))
      }, 50)
    }

    close() {}
  }
}, { logs })
let selected = client
await context.route('**/__lab/state', route => route.fulfill({ json: { ...frozen, reports: [selected], archived: [], logs, ready: false } }))
await context.route('**/__review/before', route => route.fulfill({ contentType: 'text/html', body: renderPage(selected.report, { cwd: frozen.cwd, theme: { scheme: 'dark' }, channel: '/__review' }) }))
const before = await context.newPage()
const after = await context.newPage()
async function reset(scenario = client) {
  selected = scenario
  await before.goto(`${origin}/__review/before`)
  await after.goto(`${origin}/screen.html?view=focus&theme=dark`)
  await after.locator('#error-title').waitFor()
  await after.locator('.connection-banner').waitFor({ state: 'hidden' })
  await after.getByRole('button', { name: 'Hide page preview', exact: true }).click()
  await Promise.all([before.evaluate(() => document.fonts.ready), after.evaluate(() => document.fonts.ready)])
}
async function capture(name) {
  for (const [side, page] of [['before', before], ['after', after]])
    await page.screenshot({ path: `${output}/${name}-${side}.png`, animations: 'disabled' })
}
try {
  await reset()
  await capture('overview')
  await after.locator('.source-card').first().screenshot({ path: `${output}/controls-default.png` })
  await after.getByRole('button', { name: 'More context', exact: true }).first().click()
  await after.locator('.source-card').first().screenshot({ path: `${output}/controls-expanded.png` })
  await after.getByRole('button', { name: 'Less context', exact: true }).first().click()
  for (const variant of ['precise', 'compact']) {
    selected = variant === 'compact' ? compact : client
    await after.goto(`${origin}/screen.html?view=focus&theme=dark`)
    await after.locator('#error-title').waitFor()
    await after.evaluate(() => document.fonts.ready)
    const active = after.locator('.active-line').first()
    const line = await active.boundingBox()
    const rowHeight = await after.locator('.code-line:not(.active-line)').first().evaluate(element => element.getBoundingClientRect().height)
    const source = await after.locator('.source-card').first().boundingBox()
    await after.screenshot({ path: `${output}/source-detail-${variant}.png`, clip: { x: source.x, y: line.y - rowHeight, width: source.width, height: line.height + rowHeight * 2 }, animations: 'disabled' })
  }
  await reset()
  // Capture each disclosure state from the live renderers, using the same report.
  await before.screenshot({ path: `${output}/stack-current-closed.png`, fullPage: true, animations: 'disabled' })
  await before.locator('[data-frame-toggle]').nth(1).click()
  await before.screenshot({ path: `${output}/stack-current-open.png`, fullPage: true, animations: 'disabled' })
  for (const group of await before.locator('[data-group] > summary').all())
    await group.click()
  await before.screenshot({ path: `${output}/stack-current-framework.png`, fullPage: true, animations: 'disabled' })
  for (const view of ['focus', 'stack']) {
    await after.goto(`${origin}/screen.html?view=${view}&theme=dark`)
    await after.locator('#error-title').waitFor()
    await after.locator('.connection-banner').waitFor({ state: 'hidden' })
    await after.getByRole('button', { name: 'Hide page preview', exact: true }).click()
    await after.evaluate(() => document.fonts.ready)
    await after.screenshot({ path: `${output}/stack-${view}-closed.png`, fullPage: true, animations: 'disabled' })
    await after.locator('[data-action="stack-toggle"]').click()
    if (view === 'focus')
      await after.locator('[data-action="frame"]').first().click()
    await after.screenshot({ path: `${output}/stack-${view}-open.png`, fullPage: true, animations: 'disabled' })
    await after.locator('[data-action="framework"]').click()
    await after.screenshot({ path: `${output}/stack-${view}-framework.png`, fullPage: true, animations: 'disabled' })
  }
  if (!frozen.causeExample)
    throw new Error('Capture a report with one direct cause for the cause-navigation comparison.')
  await reset(frozen.causeExample)
  await after.goto(`${origin}/screen.html?view=stack&theme=dark`)
  await after.locator('#error-title').waitFor()
  await after.locator('.connection-banner').waitFor({ state: 'hidden' })
  await after.getByRole('button', { name: 'Hide page preview', exact: true }).click()
  await capture('causes')
  await after.locator('.single-cause [data-action="cause-select"]').click()
  await after.getByRole('heading', { name: frozen.causeExample.report.causes[0].message, exact: true }).waitFor()
  await after.screenshot({ path: `${output}/causes-inspected.png`, animations: 'disabled' })
  await after.locator('.single-cause [data-action="cause-select"]').click()
  await after.getByRole('heading', { name: frozen.causeExample.report.message, exact: true }).waitFor()
  if (!frozen.relatedExample)
    throw new Error('Capture the import scenario with several related errors first.')
  await reset(frozen.relatedExample)
  await after.goto(`${origin}/screen.html?view=stack&theme=dark`)
  await after.locator('#error-title').waitFor()
  await after.locator('.connection-banner').waitFor({ state: 'hidden' })
  await after.getByRole('button', { name: 'Hide page preview', exact: true }).click()
  await after.evaluate(() => document.fonts.ready)
  await capture('related')
  await after.locator('.cause-picker summary').click()
  await after.screenshot({ path: `${output}/related-menu.png`, animations: 'disabled' })
  for (const [index, error] of frozen.relatedExample.report.errors.entries()) {
    if (!await after.locator('.cause-picker').evaluate(element => element.open))
      await after.locator('.cause-picker summary').click()
    await after.locator(`.trace-choices [data-id="${error.id}"]`).click()
    await after.getByRole('heading', { name: error.message, exact: true }).waitFor()
    await after.screenshot({ path: `${output}/related-row-${index + 1}.png`, animations: 'disabled' })
  }
  await after.locator('.compact-trace > [data-action="cause-select"]').click()
  await after.getByRole('heading', { name: frozen.relatedExample.report.message, exact: true }).waitFor()
  await reset()
  await before.locator('[data-action="copy-menu"]').click()
  await after.getByRole('button', { name: 'More copy formats', exact: true }).click()
  await capture('copy')
  await reset()
  await before.getByRole('button', { name: 'Server logs', exact: true }).click()
  await after.getByRole('button', { name: 'Logs', exact: true }).click()
  await before.locator('.mb-log-scroll').evaluate(element => element.scrollTop = element.scrollHeight)
  await capture('logs')
  await writeFile(`${output}/capture-state.json`, `${JSON.stringify({ ...frozen, reports: [client], archived: [cause], logs }, null, 2)}\n`)
  const prototypeHash = createHash('sha256')
  for (const file of ['main.ts', 'screen.css', 'style.css'])
    prototypeHash.update(await readFile(new URL(file, import.meta.url)))
  await writeFile(`${output}/manifest.json`, `${JSON.stringify({ capturedAt: new Date().toISOString(), baselineCommit: execFileSync('git', ['log', '-1', '--format=%h', '--', 'src'], { encoding: 'utf8' }).trim(), prototypeCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), prototypeSourceHash: prototypeHash.digest('hex'), prototypeIncludesWorkingChanges: true, viewport: { width: 1280, height: 900 }, renderer: 'dist built from current src; Focus and Stack from the current playground working tree', scenarios: { client: client.report.message, cause: frozen.causeExample.report.message, related: frozen.relatedExample.report.message }, transport: 'Frozen real captured reports and 40 log entries; no timing comparison.', sourceDetail: 'Two real captured errors: property access at column 20, and an explicit save-error wrapper reported at column 1 in indentation. Column metadata is unchanged.', pageMode: 'Standalone page mode. Stack states capture full content height; source details are cropped. PiP is available separately in the live playground.' }, null, 2)}\n`)
  const review = await context.newPage()
  await review.setViewportSize({ width: 1600, height: 1000 })
  await review.goto(`${origin}/review/index.html`)
  await review.locator('.board').first().waitFor()
  await review.addStyleTag({ content: '.toolbar { position: static; } .board { padding: 40px 32px; } .export-board { display: none; } .technical summary { list-style: none; }' })
  await review.locator('img').evaluateAll(images => images.forEach(image => image.loading = 'eager'))
  await review.evaluate(() => Promise.all([...document.images].map(image => image.decode().catch(() => {}))))
  await review.evaluate(() => document.fonts.ready)
  await review.locator('.technical').evaluateAll(elements => elements.forEach(element => element.open = true))
  await mkdir(`${output}/boards`, { recursive: true })
  for (const name of ['overview', 'source-detail', 'stack', 'causes', 'related', 'copy', 'logs'])
    await review.locator(`#${name}`).screenshot({ path: `${output}/boards/${name}.png`, animations: 'disabled' })
}
finally {
  await browser.close()
}

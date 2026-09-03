import type { Browser, Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createReport, renderOverlay, renderPage } from '../src'
import { nuxtTheme } from '../src/presets'

/**
 * WCAG 2.2 AA audit of every default theme state, following A11Y.md:
 * contrast is computed from rendered colours (SC 1.4.3 text 4.5:1, SC 1.4.11
 * UI 3:1), axe-core runs with no critical or serious violations, targets are
 * at least 24x24 (SC 2.5.8), text is at least 12px (house rule), and focus
 * rings are visible with 3:1 against their surroundings.
 */

const require = createRequire(import.meta.url)
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')

interface Sample {
  selector: string
  text: string
  fg: string
  bg: string
  ratio: number
  fontSize: number
  fontWeight: number
  role: 'text' | 'ui'
}

const themes = [
  { name: 'default light', scheme: 'light' as const, theme: undefined },
  { name: 'default dark', scheme: 'dark' as const, theme: undefined },
  { name: 'nuxt light', scheme: 'light' as const, theme: nuxtTheme },
  { name: 'nuxt dark', scheme: 'dark' as const, theme: nuxtTheme },
]

let browser: Browser
let pageHtml: (theme: typeof themes[number]) => string
let overlayHtml: (theme: typeof themes[number]) => string

beforeAll(async () => {
  browser = await chromium.launch()
  const error = new Error('Widget needs a name')
  error.stack = `Error: Widget needs a name
    at new Widget (/proj/src/widget.ts:4:13)
    at makeWidget (/proj/src/widget.ts:10:10)
    at dep (/proj/node_modules/dep/index.js:1:1)
    at node:internal/main:1:1`
  const report = await createReport(Object.assign(error, { code: 'E1001', statusCode: 500 }), {
    cwd: '/proj',
    loaders: [{ name: 'memory', read: () => 'export class Widget {\n  constructor(public name: string) {\n    if (!name) {\n      throw new TypeError(\'Widget needs a name\') // comment\n    }\n  }\n}\nexport function makeWidget(name: string) {\n  const n = 42\n  return new Widget(name)\n}\n' }],
  })
  report.hint = 'Check the `name` prop passed from the parent component.'
  report.docsUrl = 'https://nuxt.com/docs/errors/e1001'
  report.trace = [{ label: '<App>', file: '/proj/app.vue' }, { label: '<Widget>' }]
  report.sections.push({ id: 'request', title: 'Request', content: { method: 'GET', url: '/widgets' } })
  report.causes.push({ ...report, id: 'cause', message: 'Inner failure', causes: [], trace: undefined, hint: undefined })
  pageHtml = theme => renderPage(report, { cwd: '/proj', channel: '/__my-bad', theme: theme.theme ? { ...theme.theme, scheme: theme.scheme } : { scheme: theme.scheme } })
  overlayHtml = theme => `<!DOCTYPE html><html lang="en"><head><title>Host</title></head><body><h1>Host page</h1>${renderOverlay(report, { cwd: '/proj', channel: '/__my-bad', theme: theme.theme ? { ...theme.theme, scheme: theme.scheme } : { scheme: theme.scheme } })}</body></html>`
}, 30_000)

afterAll(() => browser.close())

async function open(html: string, scheme: 'light' | 'dark', options: { reducedMotion?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 }, reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference' })
  const page = await context.newPage()
  await page.route('**/__my-bad/**', route => route.abort())
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('details')) {
      details.open = true
    }
  })
  return page
}

/** Computed WCAG contrast for every visible text node and for UI component borders/icons, walking shadow roots. */
async function sampleContrast(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const parse = (color: string): [number, number, number, number] | undefined => {
      if (!color || color === 'transparent') {
        return [0, 0, 0, 0]
      }
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#123456'
      context.fillStyle = color
      if (context.fillStyle === '#123456' && color !== '#123456') {
        return undefined
      }
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      if (a === 0) {
        return [0, 0, 0, 0]
      }
      // Un-premultiply so semi-transparent layers blend correctly later.
      const alpha = a! / 255
      return [Math.min(255, r! / alpha), Math.min(255, g! / alpha), Math.min(255, b! / alpha), alpha]
    }
    const luminance = ([r, g, b]: [number, number, number, number]) => {
      const channel = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const blend = (top: [number, number, number, number], under: [number, number, number, number]): [number, number, number, number] => {
      const a = top[3]
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]
    }
    const ratio = (a: [number, number, number, number], b: [number, number, number, number]) => {
      const l1 = luminance(a)
      const l2 = luminance(b)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    const backgroundOf = (element: Element): [number, number, number, number] => {
      const layers: [number, number, number, number][] = []
      let node: Element | null = element
      while (node) {
        const style = getComputedStyle(node)
        const color = parse(style.backgroundColor)
        if (color && color[3] > 0) {
          layers.push(color)
          if (color[3] === 1) {
            break
          }
        }
        node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)
      }
      let result: [number, number, number, number] = [255, 255, 255, 1]
      for (const layer of layers.reverse()) {
        result = blend(layer, result)
      }
      return result
    }
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
    }
    const selectorFor = (element: Element) => {
      const parts: string[] = []
      let node: Element | null = element
      while (node && parts.length < 3) {
        parts.unshift(`${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`)
        node = node.parentElement
      }
      return parts.join(' > ')
    }
    const samples: Sample[] = []
    const roots: (Document | ShadowRoot)[] = [document]
    for (const host of document.querySelectorAll('*')) {
      if (host.shadowRoot) {
        roots.push(host.shadowRoot)
      }
    }
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let textNode: Node | null
      // eslint-disable-next-line no-cond-assign
      while ((textNode = walker.nextNode())) {
        const text = textNode.textContent?.trim()
        const element = textNode.parentElement
        if (!text || !element || !visible(element) || element.closest('.mb-sr-only, [aria-hidden="true"], script, style')) {
          continue
        }
        const style = getComputedStyle(element)
        const fg = parse(style.color)
        if (!fg) {
          samples.push({ selector: selectorFor(element), text: `UNPARSED ${style.color}`, fg: style.color, bg: '', ratio: 0, fontSize: Number.parseFloat(style.fontSize), fontWeight: 400, role: 'text' })
          continue
        }
        const bg = backgroundOf(element)
        samples.push({
          selector: selectorFor(element),
          text: text.slice(0, 40),
          fg: style.color,
          bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
          ratio: Math.round(ratio(blend(fg, bg), bg) * 100) / 100,
          fontSize: Number.parseFloat(style.fontSize),
          fontWeight: Number(style.fontWeight),
          role: 'text',
        })
      }
      for (const element of root.querySelectorAll('button, [role="progressbar"], summary, input, select')) {
        if (!visible(element) || element.closest('[aria-hidden="true"]')) {
          continue
        }
        const style = getComputedStyle(element)
        const border = parse(style.borderTopColor)
        const bg = backgroundOf(element)
        const icon = element.querySelector('svg')
        const iconColor = icon ? parse(getComputedStyle(icon).color) : undefined
        const color = iconColor ?? (border && border[3] > 0 && Number.parseFloat(style.borderTopWidth) > 0 ? border : undefined)
        if (color) {
          samples.push({ selector: selectorFor(element), text: (element as HTMLElement).getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '', fg: style.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`, ratio: Math.round(ratio(blend(color, bg), bg) * 100) / 100, fontSize: 0, fontWeight: 0, role: 'ui' })
        }
      }
    }
    return samples
  })
}

function largeText(sample: Sample): boolean {
  return sample.fontSize >= 24 || (sample.fontSize >= 18.66 && sample.fontWeight >= 700)
}

describe.each(themes)('theme: $name', (theme) => {
  it('meets text and UI contrast minimums in the page and the overlay', async () => {
    for (const html of [pageHtml(theme), overlayHtml(theme)]) {
      const page = await open(html, theme.scheme)
      const samples = await sampleContrast(page)
      expect(samples.length).toBeGreaterThan(20)
      const failures = samples.filter(sample => sample.role === 'text' ? sample.ratio < (largeText(sample) ? 3 : 4.5) : sample.ratio < 3)
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([])
      await page.context().close()
    }
  }, 30_000)

  it('has no text below 12px and no target below 24x24', async () => {
    const page = await open(pageHtml(theme), theme.scheme)
    const overlayPage = await open(overlayHtml(theme), theme.scheme)
    const shadowTargets = await overlayPage.evaluate(() => [...document.querySelector('my-bad-overlay')!.shadowRoot!.querySelectorAll<HTMLElement>('button, a, summary, [tabindex="0"]')]
      .filter(el => el.getClientRects().length && !el.closest('.mb-code, .mb-hint'))
      .map(el => ({ selector: `${el.tagName.toLowerCase()}[${el.getAttribute('data-action') ?? el.className}]`, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
      .filter(target => target.width < 24 || target.height < 24))
    expect(shadowTargets, JSON.stringify(shadowTargets)).toEqual([])
    await overlayPage.context().close()
    const small = (await sampleContrast(page)).filter(sample => sample.role === 'text' && sample.fontSize < 12)
    expect(small, JSON.stringify(small, null, 2)).toEqual([])
    const targets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a, summary, [tabindex="0"]')]
      .filter(el => el.getClientRects().length && !el.closest('.mb-code, .mb-hint'))
      .map(el => ({ selector: `${el.tagName.toLowerCase()}[${el.getAttribute('data-action') ?? el.className}]`, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
      .filter(target => target.width < 24 || target.height < 24))
    expect(targets, JSON.stringify(targets)).toEqual([])
    await page.context().close()
  }, 30_000)

  it('has no serious or critical axe violations, including in opened states', async () => {
    for (const html of [pageHtml(theme), overlayHtml(theme)]) {
      const page = await open(html, theme.scheme)
      await page.evaluate(() => {
        const root = document.querySelector('my-bad-overlay')?.shadowRoot ?? document
        ;(root.querySelector('[data-action="copy-menu"]') as HTMLElement | null)?.click()
        ;(root.querySelector('[data-action="logs"]') as HTMLElement | null)?.click()
        const toasts = root.querySelector('[data-toasts]')
        if (toasts) {
          toasts.innerHTML = '<article class="mb-toast" data-toast data-toast-id="w"><svg viewBox="0 0 24 24" aria-hidden="true"></svg><button type="button" class="mb-toast-body" data-action="show-toast"><strong>Vue warn</strong><span>Extraneous attribute</span></button><button type="button" class="mb-tool" data-action="dismiss-toast" aria-label="Dismiss warning"></button></article>'
        }
        const list = root.querySelector('[data-log-list]')
        if (list) {
          list.innerHTML = '<li class="mb-log" data-level="error"><time>12:00:00</time><span class="mb-log-level">error</span><span>failed</span></li><li class="mb-log" data-level="warn"><time>12:00:01</time><span class="mb-log-level">warn</span><span>careful</span></li>'
        }
        const bar = root.querySelector<HTMLElement>('[data-progress]')
        if (bar) {
          bar.hidden = false
          bar.style.setProperty('--mb-progress', '40%')
        }
      })
      await page.addScriptTag({ content: axeSource })
      const results = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string, impact: string, nodes: Array<{ target: string[], failureSummary?: string }> }> }> } }).axe
        return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
      })
      const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      expect(serious.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 5) })), JSON.stringify(serious, null, 2)).toEqual([])
      await page.context().close()
    }
  }, 60_000)

  it('shows a visible focus ring with 3:1 contrast', async () => {
    const page = await open(pageHtml(theme), theme.scheme)
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const style = getComputedStyle(el)
      return { selector: `${el.tagName}.${el.className}`, outlineWidth: Number.parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle, boxShadow: style.boxShadow }
    })
    expect((ring.outlineStyle !== 'none' && ring.outlineWidth >= 2) || ring.boxShadow !== 'none', JSON.stringify(ring)).toBe(true)
    await page.context().close()
  })
})

describe('motion and structure', () => {
  it('disables animation under prefers-reduced-motion', async () => {
    const page = await open(pageHtml(themes[0]!), 'light', { reducedMotion: true })
    const animated = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const style = getComputedStyle(el)
      return (style.animationName !== 'none' && style.animationDuration !== '0s') || (style.transitionDuration !== '0s' && style.transitionProperty !== 'none' && style.transitionDuration.split(',').some(d => Number.parseFloat(d) > 0))
    }).map(el => el.className))
    expect(animated).toEqual([])
    await page.context().close()
    const overlay = await open(overlayHtml(themes[0]!), 'light', { reducedMotion: true })
    await overlay.locator('my-bad-overlay').locator('[data-preview] [data-action="minimize"]').click()
    await overlay.waitForTimeout(100)
    expect(await overlay.evaluate(() => document.querySelector('my-bad-overlay')!.shadowRoot!.querySelector('[data-overlay]')!.getAnimations({ subtree: true }).length)).toBe(0)
    expect(await overlay.evaluate(() => getComputedStyle(document.querySelector('my-bad-overlay')!.shadowRoot!.querySelector('[data-overlay]')!).opacity)).toBe('1')
    await overlay.context().close()
  })

  it('leaves no lingering animation or opacity after minimising with motion enabled', async () => {
    const page = await open(overlayHtml(themes[0]!), 'light')
    await page.locator('my-bad-overlay').locator('[data-preview] [data-action="minimize"]').click()
    await page.waitForTimeout(700)
    const state = await page.evaluate(() => {
      const el = document.querySelector('my-bad-overlay')!.shadowRoot!.querySelector<HTMLElement>('[data-overlay]')!
      const rect = el.getBoundingClientRect()
      return { animations: el.getAnimations({ subtree: true }).length, opacity: getComputedStyle(el).opacity, top: rect.top, height: rect.height }
    })
    expect(state.animations).toBe(0)
    expect(state.opacity).toBe('1')
    expect(state.top).toBeGreaterThan(0)
    expect(state.height).toBeLessThan(300)
    await page.context().close()
  })

  it('has one h1, no heading level skips and a descriptive title', async () => {
    const aggregate = await createReport(new AggregateError([new Error('one'), new Error('two')], 'several'), { loaders: [], snippets: false })
    aggregate.causes.push({ ...aggregate, id: 'c', message: 'nested', causes: [], errors: undefined })
    const page = await open(renderPage(aggregate, { channel: '/__my-bad' }), 'light')
    const levels = await page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(h => Number(h.tagName[1])))
    expect(levels.filter(level => level === 1)).toHaveLength(1)
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!, JSON.stringify(levels)).toBeLessThanOrEqual(1)
    }
    expect(levels.length).toBeGreaterThan(3)
    await page.context().close()
    const page2 = await open(pageHtml(themes[0]!), 'light')
    expect(await page2.title()).toContain('Widget needs a name')
    await page2.context().close()
  })
})

describe('operability', () => {
  it('reflows at 320px without horizontal page scrolling', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } })
    const page = await context.newPage()
    await page.route('**/__my-bad/**', route => route.abort())
    await page.setContent(pageHtml(themes[0]!))
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(320)
    await context.close()
  })

  it('survives WCAG text spacing without clipping the message or hint', async () => {
    const page = await open(pageHtml(themes[0]!), 'light')
    await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' })
    const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('h1, h2, [data-message], [data-hint], .mb-kicker, summary')]
      .filter(el => getComputedStyle(el).overflow === 'hidden' && el.scrollHeight > el.clientHeight + 1)
      .map(el => el.className))
    expect(clipped).toEqual([])
    await page.context().close()
  })

  it('keeps focus inside the maximised overlay and releases it when minimised', async () => {
    const page = await open(overlayHtml(themes[0]!), 'light')
    const hostInert = () => page.evaluate(() => document.querySelector('h1')!.hasAttribute('inert'))
    expect(await hostInert()).toBe(true)
    const dialog = page.locator('my-bad-overlay').locator('[data-overlay]')
    expect(await dialog.getAttribute('aria-modal')).toBe('true')
    expect(await dialog.locator('[data-action="minimize"]:visible').count()).toBeGreaterThan(0)
    const reached: string[] = []
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      reached.push(await page.evaluate(() => {
        const active = document.activeElement
        const inner = active?.shadowRoot?.activeElement
        return inner ? `overlay:${inner.tagName}` : `host:${active?.tagName}`
      }))
    }
    expect(reached.filter(item => item.startsWith('host:') && item !== 'host:BODY')).toEqual([])
    const insideDialog = await page.evaluate(() => {
      const shadow = document.querySelector('my-bad-overlay')!.shadowRoot!
      return shadow.activeElement ? shadow.querySelector('[data-overlay]')!.contains(shadow.activeElement) : true
    })
    expect(insideDialog).toBe(true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    expect(await dialog.getAttribute('data-minimized')).toBe('')
    expect(await hostInert()).toBe(false)
    await page.locator('my-bad-overlay').locator('[data-action="hide"]').click()
    expect(await dialog.getAttribute('inert')).toBe('')
    await page.context().close()
  }, 30_000)
})

describe('minimised overlay and layered escape', () => {
  it('restores the minimised card by keyboard and manages focus', async () => {
    const page = await open(overlayHtml(themes[0]!), 'light')
    const shadow = () => page.evaluate(() => document.querySelector('my-bad-overlay')!.shadowRoot!.activeElement?.className ?? '')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const dialog = page.locator('my-bad-overlay').locator('[data-overlay]')
    expect(await dialog.getAttribute('data-minimized')).toBe('')
    expect(await shadow()).toContain('mb-overlay-expand')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    expect(await dialog.getAttribute('data-minimized')).toBeNull()
    expect(await page.evaluate(() => document.querySelector('my-bad-overlay')!.shadowRoot!.activeElement?.tagName)).toBe('MAIN')
    await page.context().close()
  })

  it('escape closes the topmost layer only', async () => {
    const page = await open(overlayHtml(themes[0]!), 'light')
    const overlay = page.locator('my-bad-overlay')
    await overlay.locator('[data-action="copy-menu"]').click()
    expect(await overlay.locator('[data-menu-list]:not([hidden])').count()).toBe(1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    expect(await overlay.locator('[data-menu-list]:not([hidden])').count()).toBe(0)
    expect(await overlay.locator('[data-overlay]').getAttribute('data-minimized')).toBeNull()
    expect(await page.evaluate(() => document.querySelector('my-bad-overlay')!.shadowRoot!.activeElement?.getAttribute('data-action'))).toBe('copy-menu')
    await page.context().close()
  })

  it('makes an overflowing log drawer keyboard scrollable', async () => {
    const page = await open(pageHtml(themes[0]!), 'light')
    await page.evaluate(() => {
      const list = document.querySelector('[data-log-list]')!
      list.innerHTML = Array.from({ length: 80 }, (_, i) => `<li class="mb-log" data-level="info"><time>12:00:${String(i).padStart(2, '0')}</time><span class="mb-log-level">info</span><span>line ${i}</span></li>`).join('')
    })
    await page.click('[data-action="logs"]')
    await page.waitForTimeout(100)
    await page.addScriptTag({ content: axeSource })
    const results = await page.evaluate(async () => (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string }> }> } }).axe.run(document, { runOnly: ['scrollable-region-focusable', 'region'] }))
    expect(results.violations.map(v => v.id)).toEqual([])
    await page.context().close()
  })

  it('embeds state as ASCII so host charset cannot corrupt it', async () => {
    const report = await createReport(new Error('naïve — ›'), { loaders: [], snippets: false })
    const html = renderOverlay(report)
    const start = html.indexOf('<script type="application/json">') + '<script type="application/json">'.length
    const state = html.slice(start, html.indexOf('</script>', start))
    // eslint-disable-next-line no-control-regex
    expect(state).toMatch(/^[\x00-\x7F]*$/)
    expect(JSON.parse(state).report.message).toBe('naïve — ›')
  })
})

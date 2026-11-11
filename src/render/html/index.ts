import type { ErrorReport, HistoryEntry } from '../../types'
import type { BadgeState, Dock, DockedState, PageState, Theme } from './state'
import { getClientScript, getClientStyles } from 'virtual:my-bad-client'
import { plainText } from '../../report/code'
import { clampMessage, splitHeadline } from '../../report/message'
import { assetHash, assetUrls } from './assets'
import { attr, escapeHtml, escapeScript } from './escape'
import { THEME_STORAGE_KEY } from './state'
import { themeStyles } from './theme'
import { renderView } from './view'

export { clientAssets } from './assets'
export type { Dock, PageState, Theme } from './state'

export interface ClientAssets {
  /** URL serving `clientAssets.script`. */
  script?: string
  /** URL serving `clientAssets.styles`. */
  styles?: string
}

export interface RenderHtmlOptions {
  /** Where the error occurred, e.g. `Server` or `Client`. */
  environment?: string
  cwd?: string
  /**
   * Load the client script and stylesheet from these URLs instead of inlining
   * them, which keeps ~60kB out of every rendered page. Serve the contents of
   * `clientAssets` at the URLs you pass.
   */
  assets?: ClientAssets
  /** Base path of the live channel, e.g. `/__my-bad`. */
  channel?: string
  history?: HistoryEntry[]
  theme?: Theme
  /** URL scheme for opening files when no `open` action is available. Default `vscode`. */
  editor?: string
  /**
   * Embed `rawStack` in the page state. Nothing in the rendered UI reads it, and
   * it stays available over the channel at `GET {channel}/history/{id}`.
   * Default `false`.
   */
  rawStack?: boolean
  /** Characters of the message shown before a "show full message" button. Default `1000`. */
  maxMessageLength?: number
  /**
   * Correlation id of the request this page was rendered for. The channel then
   * only sends it errors from that request, and errors from no request at all.
   * Without it the page's path is matched against the request instead.
   */
  requestId?: string
  /**
   * CSP nonce of the page. Every `<script>` and stylesheet rendered carries it,
   * and so does each one the client adds to the page at runtime.
   */
  nonce?: string
}

export interface RenderPageOptions extends RenderHtmlOptions {
  /** Document title. Defaults to the error name and message. */
  title?: string
  /** Raw HTML appended before `</body>`. */
  inject?: string
  /** Extra `<head>` markup. */
  head?: string
}

export interface RenderOverlayOptions extends RenderHtmlOptions {
  /** Mount minimised regardless of the user's remembered preference, which can otherwise only mount minimised, never expanded. */
  startMinimized?: boolean
  /** Corner the minimised overlay, and the badge, dock to until the user moves them. Default `bottom-right`. */
  dock?: Dock
  /** Custom element tag name. Default `my-bad-overlay`. */
  tag?: string
}

export interface RenderBadgeOptions extends Omit<RenderOverlayOptions, 'assets' | 'channel' | 'history' | 'rawStack'> {
  /** Base path of the live channel, e.g. `/__my-bad`. */
  channel: string
  /**
   * URLs serving `clientAssets`, instead of the ones the channel serves. The
   * overlay script and stylesheet load only once the overlay is needed.
   */
  assets?: ClientAssets & { badge?: string }
  /** Mount the overlay for an error minimised, regardless of the user's remembered preference. Default `true`. */
  startMinimized?: boolean
  /**
   * Milliseconds to wait at most for Vite DevTools to take over the badge
   * before mounting the overlay for an error, when the channel reports a
   * registered my-bad dock (`channel.setDevTools(true)`). Default `0`.
   */
  awaitHost?: number
}

const TAG_RE = /^[a-z][a-z0-9]*-[a-z0-9-]+$/

/** The built-in stylesheet, inlined unless it is served separately. */
function sheet(assets: ClientAssets | undefined): string {
  return assets?.styles
    ? ''
    : getClientStyles()
}

function nonceAttr(nonce: string | undefined): string {
  return attr('nonce', nonce || undefined)
}

/** Applies the remembered or preferred colour scheme before first paint. */
function themeBootstrap(nonce?: string): string {
  return `<script${nonceAttr(nonce)}>(function(){var t;try{t=localStorage.getItem(${escapeScript(JSON.stringify(THEME_STORAGE_KEY))})}catch(e){}try{if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()</script>\n`
}

function stateScript(state: PageState, options: RenderHtmlOptions): string {
  const nonce = nonceAttr(options.nonce)
  const script = options.assets?.script
    ? `<script${nonce} src="${escapeHtml(options.assets.script)}"></script>`
    : `<script${nonce}>${getClientScript()}</script>`
  const json = JSON.stringify(state, options.rawStack
    ? undefined
    : (key, value) => key === 'rawStack'
        ? undefined
        : value)
  return `<script type="application/json"${nonce}>${escapeScript(json)}</script>\n${script}`
}

function baseState(options: RenderHtmlOptions, mode: PageState['mode']): Omit<PageState, 'report'> {
  return {
    mode,
    environment: options.environment,
    cwd: options.cwd,
    channel: options.channel,
    history: options.history,
    theme: options.theme,
    editor: options.editor,
    maxMessageLength: options.maxMessageLength,
    requestId: options.requestId,
    version: __MY_BAD_VERSION__,
  }
}

/** Render a complete HTML document for the report. */
export function renderPage(report: ErrorReport, options: RenderPageOptions = {}): string {
  const state = {
    ...baseState(options, 'page'),
    report,
  }
  const title = options.title ?? `${report.name}: ${clampMessage(plainText(splitHeadline(report.message).headline, report.codeSpans), options.maxMessageLength).head}`
  const scheme = options.theme?.scheme
  const nonce = nonceAttr(options.nonce)
  const bootstrap = scheme
    ? ''
    : themeBootstrap(options.nonce)
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"${scheme
  ? ` data-theme="${escapeHtml(scheme)}"`
  : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${bootstrap}${options.assets?.styles
  ? `<link rel="stylesheet"${nonce} href="${escapeHtml(options.assets.styles)}">\n`
  : ''}<style${nonce}>html{background:var(--mb-bg)}html,body{margin:0;height:100%}${sheet(options.assets)}${themeStyles(options.theme, ':root')}</style>
${options.head ?? ''}
</head>
<body>
<div class="mb-root" data-my-bad-root>${renderView(state)}</div>
${stateScript(state, options)}
${options.inject ?? ''}
</body>
</html>`
}

/**
 * Render a self-contained overlay to inject into an existing page (before `</body>`).
 * The overlay renders inside a shadow root, so host styles cannot leak in.
 */
export function renderOverlay(report: ErrorReport, options: RenderOverlayOptions = {}): string {
  const state: PageState = {
    ...overlayState(options),
    report,
  }
  return `<${state.tag}></${state.tag}>\n${stateScript(state, options)}`
}

function overlayState(options: RenderOverlayOptions): Omit<PageState, 'report'> {
  const tag = options.tag ?? 'my-bad-overlay'
  if (!TAG_RE.test(tag)) {
    throw new Error(`Invalid custom element name: ${tag}`)
  }
  return {
    ...baseState(options, 'overlay'),
    startMinimized: options.startMinimized,
    dock: options.dock,
    tag,
    styles: `${sheet(options.assets)}${themeStyles(options.theme, ':host')}\n:host{all:initial;direction:ltr;display:contents}`,
    stylesUrl: options.assets?.styles,
  }
}

/**
 * Render the badge for every dev page, anywhere in the page. It loads from the
 * channel and renders nothing until something concerns the page: an error
 * mounts the overlay, and warnings show a small count that expands into it.
 * It dispatches `my-bad:error:clear` on `window` when the page's error clears.
 */
export function renderBadge(options: RenderBadgeOptions): string {
  const { state, src } = badgeState(options)
  const nonce = nonceAttr(options.nonce)
  return `<script type="application/json"${nonce}>${escapeScript(JSON.stringify(state))}</script>\n<script defer${nonce} src="${escapeHtml(src)}"></script>`
}

/** The state `renderBadge` embeds, and the URL of the badge script. */
export function badgeState(options: RenderBadgeOptions): { state: BadgeState, src: string } {
  const served = assetUrls(options.channel)
  const script = options.assets?.script ?? served.script
  const styles = options.assets?.styles ?? served.styles
  return {
    state: {
      overlay: overlayState({
        ...options,
        startMinimized: options.startMinimized ?? true,
        assets: { script, styles },
      }),
      script,
      awaitHost: options.awaitHost || undefined,
    },
    src: options.assets?.badge ?? served.badge,
  }
}

/**
 * The page a channel serves at `{channel}/panel`: every open error, warning and
 * problem set, each shown the way the overlay shows it. With `embed`, it takes
 * the scope, theme and paths of the badge on the page embedding it. With
 * `drawer`, it has a button closing the badge's drawer it is shown in.
 */
export function renderDockedPage(options: { channel: string, embed?: boolean, drawer?: boolean, nonce?: string }): string {
  const state: DockedState = {
    mode: 'docked',
    channel: options.channel,
    embed: options.embed,
    drawer: options.drawer,
    version: __MY_BAD_VERSION__,
  }
  const asset = (key: 'script' | 'styles') => `${options.channel}/${key === 'script'
    ? 'client.js'
    : 'client.css'}?v=${assetHash(key)}`
  const nonce = nonceAttr(options.nonce)
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>my-bad</title>
${themeBootstrap(options.nonce)}<link rel="stylesheet"${nonce} href="${escapeHtml(asset('styles'))}">
<style${nonce}>html{background:var(--mb-bg)}html,body{margin:0;min-height:100%}</style>
</head>
<body>
<div class="mb-root" data-my-bad-root data-docked></div>
<script type="application/json"${nonce}>${escapeScript(JSON.stringify(state))}</script>
<script${nonce} src="${escapeHtml(asset('script'))}"></script>
</body>
</html>`
}

/** Insert the overlay before `</body>`, or append it. Avoids `String.replace`, whose `$` patterns would corrupt the inlined script. */
export function injectOverlay(html: string, report: ErrorReport, options: RenderOverlayOptions = {}): string {
  const overlay = renderOverlay(report, options)
  const index = html.lastIndexOf('</body>')
  return index === -1
    ? html + overlay
    : `${html.slice(0, index)}${overlay}${html.slice(index)}`
}

import type { ErrorReport, HistoryEntry } from '../../types'
import type { PageState, Theme } from './state'
import { clientScript, clientStyles } from 'virtual:my-bad-client'
import { version } from '../../../package.json'
import { escapeHtml, escapeScript } from './escape'
import { renderView } from './view'

export type { PageState, Theme } from './state'

export interface RenderHtmlOptions {
  cwd?: string
  /** Base path of the live channel, e.g. `/__my-bad`. */
  channel?: string
  history?: HistoryEntry[]
  theme?: Theme
  /** URL scheme for opening files when no `open` action is available. Default `vscode`. */
  editor?: string
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
  startMinimized?: boolean
  /** Custom element tag name. Default `my-bad-overlay`. */
  tag?: string
}

const CSS_VAR_RE = /^--[\w-]+$/

/** Stylesheet plus theme overrides, with custom property names and values validated. */
function themeStyles(theme: Theme | undefined, selector: string): string {
  const vars: string[] = []
  if (theme?.accent) {
    vars.push(`--mb-accent:${cssValue(theme.accent)}`)
  }
  for (const [name, value] of Object.entries(theme?.vars ?? {})) {
    if (CSS_VAR_RE.test(name)) {
      vars.push(`${name}:${cssValue(value)}`)
    }
  }
  return `${clientStyles}${vars.length ? `\n${selector}{${vars.join(';')}}` : ''}${theme?.css ? `\n${theme.css}` : ''}`
}

function cssValue(value: string): string {
  return String(value).replace(/[;{}<]/g, '')
}

function stateScript(state: PageState & { styles?: string }): string {
  return `<script type="application/json">${escapeScript(JSON.stringify(state))}</script>\n<script>${clientScript}</script>`
}

function baseState(report: ErrorReport, options: RenderHtmlOptions, mode: PageState['mode']): PageState {
  return {
    mode,
    report,
    cwd: options.cwd,
    channel: options.channel,
    history: options.history,
    theme: options.theme,
    editor: options.editor,
    version,
  }
}

/** Render a complete HTML document for the report. */
export function renderPage(report: ErrorReport, options: RenderPageOptions = {}): string {
  const state = baseState(report, options, 'page')
  const title = options.title ?? `${report.name}: ${report.message.split('\n')[0]}`
  const scheme = options.theme?.scheme
  return `<!DOCTYPE html>
<html lang="en"${scheme ? ` data-theme="${scheme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>html{background:var(--mb-bg)}html,body{margin:0;height:100%}${themeStyles(options.theme, ':root')}</style>
${options.head ?? ''}
</head>
<body>
<div class="mb-root" data-my-bad-root>${renderView(state)}</div>
${stateScript(state)}
${options.inject ?? ''}
</body>
</html>`
}

/**
 * Render a self-contained overlay to inject into an existing page (before `</body>`).
 * The overlay renders inside a shadow root, so host styles cannot leak in.
 */
export function renderOverlay(report: ErrorReport, options: RenderOverlayOptions = {}): string {
  const tag = options.tag ?? 'my-bad-overlay'
  if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(tag)) {
    throw new Error(`Invalid custom element name: ${tag}`)
  }
  const state: PageState & { styles: string } = {
    ...baseState(report, options, 'overlay'),
    startMinimized: options.startMinimized,
    tag,
    styles: `${themeStyles(options.theme, ':host')}\n:host{all:initial;display:contents}`,
  }
  return `<${tag}></${tag}>\n${stateScript(state)}`
}

/** Insert the overlay before `</body>`, or append it. Avoids `String.replace`, whose `$` patterns would corrupt the inlined script. */
export function injectOverlay(html: string, report: ErrorReport, options: RenderOverlayOptions = {}): string {
  const overlay = renderOverlay(report, options)
  const index = html.lastIndexOf('</body>')
  return index === -1 ? html + overlay : `${html.slice(0, index)}${overlay}${html.slice(index)}`
}

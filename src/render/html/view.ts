import type { DisplayTarget } from '../../report/path'
import type { ErrorReport, Frame, HistoryEntry, Section, Snippet } from '../../types'
import type { PageState } from './state'
import { displayPath } from '../../report/path'
import { stringifyValue } from '../../report/stringify'
import { groupFrames, groupSummary } from '../frames'
import { attr, escapeHtml } from './escape'
import { highlightLine } from './highlight'

export const ICONS = {
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/></svg>',
  logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>',
  move: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>',
}

const KIND_LABEL = { error: 'Error', warning: 'Warning', compile: 'Compile error' }

export function renderView(state: PageState): string {
  const { report } = state
  const live = !!state.channel
  const name = escapeHtml(state.theme?.name ?? 'my-bad')
  const lockup = `${state.theme?.logo ?? ''}<span class="mb-brand-name${state.theme?.logo ? ' mb-sr-only' : ''}">${name}</span>`
  const brand = state.theme?.url
    ? `<a class="mb-brand" href="${escapeHtml(state.theme.url)}" target="_blank" rel="noreferrer">${lockup}<span class="mb-sr-only"> (opens in a new tab)</span></a>`
    : `<p class="mb-brand">${lockup}</p>`
  return `<header class="mb-header mb-corners">
  ${brand}
  <nav class="mb-tools" aria-label="Error page tools">
    <ul>
      ${renderPager(report, state.history)}
      <li><span class="mb-warning-count" data-warning-count hidden></span></li>
      ${live ? `<li><button class="mb-tool mb-tool-logs" type="button" data-action="logs" aria-pressed="false" aria-controls="mb-logs" title="Server logs" aria-label="Server logs">${ICONS.logs}<span class="mb-badge" data-log-count hidden></span><span class="mb-live" data-live role="status"><span class="mb-sr-only" data-live-text>Dev server: connecting</span></span></button></li>` : ''}
      ${report.sections.length ? `<li><button class="mb-tool" type="button" data-action="info" title="Request and environment info" aria-label="Request and environment info">${ICONS.info}</button></li>` : ''}
      <li class="mb-menu" data-menu>
        <button class="mb-tool" type="button" data-action="copy-menu" aria-expanded="false" aria-controls="mb-copy-menu" title="Copy" aria-label="Copy">${ICONS.copy}</button>
        <ul class="mb-menu-list" id="mb-copy-menu" data-menu-list hidden>
          <li><button type="button" data-action="copy" data-copy="markdown">Copy for issue / AI</button></li>
          <li><button type="button" data-action="copy" data-copy="message">Copy message</button></li>
          <li><button type="button" data-action="copy" data-copy="stack">Copy raw stack</button></li>
          <li><button type="button" data-action="copy" data-copy="json">Copy JSON</button></li>
        </ul>
      </li>
      <li><button class="mb-tool" type="button" data-action="theme" title="Toggle colour scheme" aria-label="Toggle colour scheme">${ICONS.theme}</button></li>
      ${state.mode === 'overlay' ? `<li><button class="mb-tool" type="button" data-action="minimize" title="Minimise (show the page behind)" aria-label="Minimise overlay and show the page behind">${ICONS.minimize}</button></li>` : ''}
    </ul>
  </nav>
  ${live ? '<div class="mb-progress" data-progress hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Build progress"><div class="mb-progress-bar"></div><span class="mb-progress-label" data-progress-label></span></div>' : ''}
</header>
<div class="mb-sr-only" role="status" aria-live="polite" data-announce></div>
<main class="mb-main" data-report-id="${escapeHtml(report.id)}" tabindex="-1">
  ${renderReport(report, state, 0)}
</main>
${live ? renderLogDrawer() : ''}
${report.sections.length ? renderInfoDialog(report.sections) : ''}
<section class="mb-toasts" data-toasts aria-live="polite" aria-label="Warnings"></section>`
}

function renderPager(report: ErrorReport, history?: HistoryEntry[]): string {
  if (!history || history.length < 2) {
    return `<li class="mb-pager" data-pager hidden></li>`
  }
  const index = Math.max(0, history.findIndex(entry => entry.id === report.id))
  return `<li class="mb-pager" data-pager><span role="group" aria-label="Error history">
    <button class="mb-tool" type="button" data-action="history" data-dir="-1"${attr('disabled', index <= 0)} title="Previous error" aria-label="Previous error">${ICONS.prev}</button>
    <span data-pager-label>${index + 1} of ${history.length}</span>
    <button class="mb-tool" type="button" data-action="history" data-dir="1"${attr('disabled', index >= history.length - 1)} title="Next error" aria-label="Next error">${ICONS.next}</button>
  </span></li>`
}

/**
 * Ids are derived from the report id and the position in the tree, so the same
 * report always renders the same markup.
 */
export function renderReport(report: ErrorReport, state: PageState, depth: number, path = 'r'): string {
  const level = Math.min(6, depth + 1)
  const tag = `h${level}`
  const id = `mb-${path}-${report.id}`
  const code = report.code
    ? `<span class="mb-code" data-code>${report.docsUrl ? `<a href="${escapeHtml(report.docsUrl)}" target="_blank" rel="noreferrer" title="Documentation for ${escapeHtml(report.code)}">${escapeHtml(report.code)}${ICONS.open}<span class="mb-sr-only"> documentation (opens in a new tab)</span></a>` : escapeHtml(report.code)}</span>`
    : ''
  return `<article class="mb-report" data-kind="${report.kind}" data-depth="${depth}" aria-labelledby="${id}-name ${id}-message">
  <p class="mb-kicker"><span data-kind-label>${depth > 0 ? 'Caused by' : KIND_LABEL[report.kind]}</span>${code}</p>
  ${report.status && depth === 0 ? `<span class="mb-status" data-status><span class="mb-sr-only">HTTP status </span>${report.status}</span>` : ''}
  <${tag} class="mb-name" id="${id}-name" data-name tabindex="-1">${escapeHtml(report.name)}${report.status && depth > 0 ? ` <span class="mb-sr-only">HTTP status ${report.status}</span>` : ''}</${tag}>
  <p class="mb-message" id="${id}-message" data-message>${escapeHtml(report.message)}</p>
  ${report.hint ? `<p class="mb-hint" data-hint>${ICONS.info}<span>${escapeHtml(report.hint)}${report.docsUrl ? ` <a href="${escapeHtml(report.docsUrl)}" target="_blank" rel="noreferrer">Learn more<span class="mb-sr-only"> (opens documentation in a new tab)</span></a>` : ''}</span></p>` : ''}
  ${report.trace?.length ? renderTrace(report, state) : ''}
  ${renderFrames(report.frames, state, id)}
  ${report.causes.map((cause, index) => renderReport(cause, state, depth + 1, `${path}c${index}`)).join('')}
  ${report.errors?.length ? `<section class="mb-aggregate" data-aggregate><h${Math.min(6, level + 1)}>${report.errors.length} errors</h${Math.min(6, level + 1)}>${report.errors.map((nested, index) => renderReport(nested, state, depth + 2, `${path}e${index}`)).join('')}</section>` : ''}
</article>`
}

function renderTrace(report: ErrorReport, state: PageState): string {
  const crumbs = report.trace!.map((entry) => {
    const inner = `<code>${escapeHtml(entry.label)}</code>`
    return entry.file
      ? `<li><button type="button" class="mb-link mb-trace-link" data-action="open"${attr('data-file', entry.file)}${attr('data-line', entry.line)}${attr('data-column', entry.column)} title="Open ${escapeHtml(shortPath(entry.file, state))}">${inner}${ICONS.open}</button></li>`
      : `<li>${inner}</li>`
  })
  return `<ol class="mb-trace" data-trace aria-label="Component trace">${crumbs.join('')}</ol>`
}

function renderFrames(frames: Frame[], state: PageState, parent: string): string {
  if (!frames.length) {
    return ''
  }
  const out: string[] = []
  let firstApp = true
  for (const entry of groupFrames(frames)) {
    if ('app' in entry) {
      out.push(renderFrame(entry.app, state, firstApp, `${parent}-f${entry.index}`))
      firstApp = false
    }
    else {
      const summary = groupSummary(entry.group.map(({ frame }) => frame))
      const items = entry.group.map(({ frame, index }) => renderFrame(frame, state, false, `${parent}-f${index}`)).join('')
      out.push(`<li><details class="mb-group" data-group><summary>${ICONS.chevron}${summary}</summary><ol>${items}</ol></details></li>`)
    }
  }
  return `<ol class="mb-frames" data-frames aria-label="Stack trace">${out.join('')}</ol>`
}

function renderFrame(frame: Frame, state: PageState, open: boolean, id: string): string {
  const fn = frame.function || frame.isAsync || frame.isConstructor || frame.isEval || !frame.snippet
    ? [frame.isAsync && '<i>async</i>', frame.isConstructor && '<i>new</i>', escapeHtml(frame.function ?? (frame.isEval ? 'eval' : '<anonymous>'))].filter(Boolean).join('')
    : ''
  const location = frame.file
    ? `<button type="button" class="mb-loc" data-loc data-action="open"${attr('data-file', frame.file)}${attr('data-line', frame.line)}${attr('data-column', frame.column)}${attr('title', frame.file)}>${renderLocation(frame, frame.line, frame.column, state)}</button>`
    : `<span class="mb-loc" data-loc data-loc-raw>${escapeHtml(frame.raw?.trim().replace(/^at\s+/, '') ?? '')}</span>`
  const inMemory = frame.compiled && frame.compiled.file === frame.file
  const compiled = frame.compiled
    ? `<button type="button" class="mb-loc mb-loc-compiled" data-loc data-loc-compiled data-action="open"${attr('data-file', frame.compiled.file)}${attr('data-line', frame.compiled.line)}${attr('data-column', frame.compiled.column)}${attr('title', inMemory ? 'Transformed module code held by the dev server; the file on disk is the source' : undefined)}>${renderLocation(frame.compiled, frame.compiled.line, frame.compiled.column, state)}${inMemory ? '<span class="mb-loc-note">in memory</span>' : ''}</button><span class="mb-switch" role="group" aria-label="Location"><button type="button" data-action="toggle-compiled" data-switch="source" aria-pressed="true">Source</button><button type="button" data-action="toggle-compiled" data-switch="compiled" aria-pressed="false">Compiled</button></span>`
    : ''
  const body = frame.snippet && frame.line !== undefined
    ? `<details class="mb-frame-body" data-frame-body id="${id}"${attr('open', open)}><summary class="mb-sr-only">Source</summary><div data-snippet-source>${renderSnippet(frame.snippet, frame.line, frame.column, frame.file ? shortPath(frame, state) : undefined)}</div>${frame.compiled?.snippet && frame.compiled.line !== undefined ? `<div data-snippet-compiled hidden>${renderSnippet(frame.compiled.snippet, frame.compiled.line, frame.compiled.column, shortPath(frame.compiled, state))}</div>` : ''}</details>`
    : ''
  return `<li class="mb-frame" data-frame data-frame-type="${frame.type}"${attr('data-has-snippet', !!body)}>
  <div class="mb-frame-head">${body ? `<button type="button" class="mb-frame-toggle" data-frame-toggle data-action="toggle-frame" aria-expanded="${open}" aria-controls="${id}" title="Toggle source" aria-label="Toggle source">${ICONS.chevron}</button>` : '<span class="mb-frame-toggle" aria-hidden="true"></span>'}<span class="mb-fn" data-fn>${fn}</span><span>${location}${compiled}</span></div>
  ${body}
</li>`
}

function renderLocation(target: DisplayTarget, line: number | undefined, column: number | undefined, state: PageState): string {
  const short = shortPath(target, state)
  const slash = short.lastIndexOf('/')
  const dir = slash === -1 ? '' : short.slice(0, slash + 1)
  const base = slash === -1 ? short : short.slice(slash + 1)
  return `<span class="mb-dir">${escapeHtml(dir)}</span><span class="mb-base">${escapeHtml(base)}</span>${line !== undefined ? `<span class="mb-pos">:${line}${column !== undefined ? `:${column}` : ''}</span>` : ''}`
}

function shortPath(target: string | DisplayTarget, state: PageState): string {
  return displayPath(target, state.cwd)
}

export function renderSnippet(snippet: Snippet, line: number, column?: number, label?: string): string {
  const gutter = String(snippet.start + snippet.lines.length - 1).length
  const rows = snippet.lines.map((text, index) => {
    const n = snippet.start + index
    const active = n === line
    const caret = active && column !== undefined && column > 0
      ? `<span class="mb-line mb-line-caret" aria-hidden="true"><span class="mb-ln"></span><span class="mb-src">${escapeHtml(text.slice(0, column - 1).replace(/[^\t]/g, ' '))}^</span></span>`
      : ''
    return `<span class="mb-line${active ? ' mb-line-active' : ''}"${active ? ' data-active aria-current="true"' : ''}><span class="mb-ln" aria-hidden="true">${String(n).padStart(gutter)}</span><span class="mb-src">${highlightLine(snippet, index) || ' '}</span></span>${caret}`
  })
  const description = `Source${label ? ` of ${label}` : ''}, line ${line} highlighted`
  return `<pre class="mb-snippet" data-lang="${escapeHtml(snippet.lang ?? '')}" aria-label="${escapeHtml(description)}" tabindex="0"><code>${rows.join('')}</code></pre>`
}

function renderLogDrawer(): string {
  return `<section class="mb-logs" id="mb-logs" data-logs hidden aria-labelledby="mb-logs-title">
  <div class="mb-logs-head">
    <h2 id="mb-logs-title">Server logs</h2>
    <label class="mb-filter">Level <select data-log-filter><option value="">all</option><option value="warn">warn+</option><option value="error">error</option></select></label>
    <button class="mb-tool" type="button" data-action="clear-logs" title="Clear logs">clear</button>
    <button class="mb-tool" type="button" data-action="logs" title="Close server logs" aria-label="Close server logs">${ICONS.close}</button>
  </div>
  <div class="mb-log-scroll" role="log" aria-live="off"><ol class="mb-log-list" data-log-list></ol></div>
</section>`
}

function renderInfoDialog(sections: Section[]): string {
  return `<dialog class="mb-info" data-info closedby="any" aria-labelledby="mb-info-title">
  <div class="mb-info-head"><h2 id="mb-info-title">Info</h2><button class="mb-tool" type="button" data-action="close-info" title="Close" aria-label="Close info">${ICONS.close}</button></div>
  ${sections.map(renderSection).join('')}
</dialog>`
}

export function renderSection(section: Section): string {
  const body = typeof section.content === 'string'
    ? `<pre class="mb-pre">${escapeHtml(section.content)}</pre>`
    : `<dl class="mb-kv">${Object.entries(section.content).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(stringifyValue(value, 2))}</dd>`).join('')}</dl>`
  return `<details class="mb-section" data-section${attr('open', !section.collapsed)}><summary>${ICONS.chevron}${escapeHtml(section.title)}</summary>${body}</details>`
}

export function renderToast(report: ErrorReport): string {
  return `<article class="mb-toast" data-toast data-kind="${report.kind}" data-toast-id="${escapeHtml(report.id)}">
  ${ICONS.warning}<button type="button" class="mb-toast-body" data-action="show-toast"><strong>${escapeHtml(report.name)}</strong><span>${escapeHtml(report.message)}</span></button>
  <button type="button" class="mb-tool" data-action="dismiss-toast" title="Dismiss warning" aria-label="Dismiss warning">${ICONS.close}</button>
</article>`
}

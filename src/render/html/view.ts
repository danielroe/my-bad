import type { DisplayTarget } from '../../report/path'
import type { ErrorReport, Frame, HistoryEntry, Section, Snippet } from '../../types'
import type { PageState } from './state'
import { displayPath } from '../../report/path'
import { stringifyValue } from '../../report/stringify'
import { groupFrames } from '../frames'
import { attr, escapeHtml, safeUrl } from './escape'
import { highlightLine } from './highlight'

export const ICONS = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6v20h12V6zM14 2v6h4M9 13h6m-6 4h6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  context: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 4-4 4 4M12 4v6m-4 6 4 4 4-4m-4 4v-6M4 12h16"/></svg>',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v3a4 4 0 0 1-4 4H6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>',
  logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>',
}

const KIND_LABEL = { error: 'Error', warning: 'Warning', compile: 'Compile error' }

function headerCount(report: ErrorReport): string {
  if (report.kind !== 'error') {
    return KIND_LABEL[report.kind]
  }
  const count = reportEntries(report).filter(entry => entry.related).length + 1
  return `${count} error${count === 1 ? '' : 's'}`
}

export function renderView(state: PageState, selected = 'r'): string {
  const { report } = state
  const live = !!state.channel
  const name = escapeHtml(state.theme?.name ?? 'my-bad')
  const lockup = `${state.theme?.logo ?? ''}<span class="mb-brand-name${state.theme?.logo ? ' mb-sr-only' : ''}">${name}</span>`
  const home = safeUrl(state.theme?.url)
  const brand = home
    ? `<a class="mb-brand" href="${escapeHtml(home)}" target="_blank" rel="noreferrer">${lockup}<span class="mb-sr-only"> (opens in a new tab)</span></a>`
    : `<p class="mb-brand">${lockup}</p>`
  return `<header class="mb-header mb-corners">
  <div class="mb-brand-group">${brand}<span class="mb-header-count">${headerCount(report)}</span></div>
  <nav class="mb-tools" aria-label="Error page tools">
    <ul>
      ${renderPager(report, state.history)}
      <li><span class="mb-warning-count" data-warning-count hidden></span></li>

      <li><button class="mb-tool" type="button" data-action="theme" title="Toggle colour scheme" aria-label="Toggle colour scheme">${ICONS.theme}</button></li>
      ${state.mode === 'overlay' ? `<li><button class="mb-tool" type="button" data-action="minimize" title="Minimise (show the page behind)" aria-label="Minimise overlay and show the page behind">${ICONS.minimize}</button></li>` : ''}
    </ul>
  </nav>
  ${live ? '<div class="mb-progress" data-progress hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Build progress"><div class="mb-progress-bar"></div><span class="mb-progress-label" data-progress-label></span></div>' : ''}
</header>
<div class="mb-sr-only" role="status" aria-live="polite" data-announce></div>
<main class="mb-main" data-report-id="${escapeHtml(report.id)}" tabindex="-1">
  ${renderReport(reportEntries(report).find(entry => entry.path === selected)?.report ?? report, state, selected)}
  ${renderFallback(state, selected)}
  <div class="mb-secondary">${report.sections.length ? `<button class="mb-tool" type="button" data-action="info">${ICONS.info}Request &amp; environment</button>` : ''}${live ? `<button class="mb-tool mb-tool-logs" type="button" data-action="logs" aria-pressed="false" aria-controls="mb-logs" title="Server logs" aria-label="Server logs">${ICONS.logs}Logs<span class="mb-badge" data-log-count hidden></span></button>` : ''}${state.history?.length ? `<details class="mb-history"><summary>${ICONS.history}History</summary><ol>${state.history.map((entry, index) => `<li><button type="button" data-action="history" data-dir="${index - Math.max(0, state.history!.findIndex(item => item.id === report.id))}">${escapeHtml(entry.message)}</button></li>`).join('')}</ol></details>` : ''}</div>
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

export function reportEntries(report: ErrorReport, path = 'r', related = false): Array<{ report: ErrorReport, path: string, label: string, related: boolean }> {
  return [{ report, path, related, label: path === 'r' ? 'Reported error' : related ? 'Related error' : report.causes.length ? 'Wrapped error' : 'Root cause' }, ...report.causes.flatMap((cause, index) => reportEntries(cause, `${path}c${index}`, related)), ...(report.errors ?? []).flatMap((error, index) => reportEntries(error, `${path}e${index}`, true))]
}

function renderCauseNavigation(state: PageState, selected: string): string {
  const entries = reportEntries(state.report)
  if (entries.length < 2)
    return ''
  const related = entries.some(entry => entry.related)
  const chain = related ? entries : entries.reverse()
  const current = chain.findIndex(entry => entry.path === selected)
  const entry = (index: number, text = chain[index]!.label) => `<button type="button" data-action="cause" data-path="${chain[index]!.path}" aria-current="${index === current}" title="${escapeHtml(chain[index]!.report.message)}">${escapeHtml(text)}</button>`
  if (chain.length === 2 && !related) {
    return `<nav class="mb-single-cause" aria-label="Error cause">${selected === 'r' ? `Caused by ${entry(0, chain[0]!.report.message)}` : entry(1, `Back to: ${state.report.message}`)}</nav>`
  }
  return `<nav class="mb-causes" aria-label="${related ? 'Related errors' : 'Error cause chain'}"><div class="mb-cause-path">${entry(0, `1 ${chain[0]!.label}`)}<details class="mb-cause-picker"><summary>${current > 0 && current < chain.length - 1 ? `${current + 1} ${chain[current]!.label}` : related ? `${chain.length - 1} related errors` : 'Wrapped errors'}${ICONS.down}</summary><ol>${chain.map((item, index) => `<li>${entry(index, `${index + 1} ${item.label}: ${item.report.message}`)}</li>`).join('')}</ol></details>${related ? '' : `${ICONS.chevron}${entry(chain.length - 1, `${chain.length} Reported error`)}`}</div><p>Inspecting ${chain[current]?.label.toLowerCase()} · ${current + 1} of ${chain.length}${selected !== 'r' ? `<span>Reported as: ${escapeHtml(state.report.message)}</span>` : ''}</p></nav>`
}

/** Causes and related errors in full, for when the picker's client script is unavailable. */
function renderFallback(state: PageState, selected: string): string {
  const all = reportEntries(state.report)
  const rest = all.filter(entry => entry.path !== selected)
  if (!rest.length) {
    return ''
  }
  const omitted = all.reduce((total, entry) => total + (entry.report.omittedErrors ?? 0), 0)
  const note = omitted ? `<p class="mb-fallback-label">and ${omitted} more related ${omitted === 1 ? 'error' : 'errors'} not shown</p>` : ''
  return `<details class="mb-disclosure mb-fallback" data-fallback><summary>${ICONS.chevron}${rest.length === 1 ? 'Cause' : 'Causes and related errors'} <span class="mb-count">${rest.length}</span></summary>${rest.map(entry => `<section class="mb-fallback-entry"><p class="mb-fallback-label">${escapeHtml(entry.label)}</p>${renderReport(entry.report, state, entry.path, false)}</section>`).join('')}${note}</details>`
}

function renderReport(report: ErrorReport, state: PageState, path: string, chrome = true): string {
  const id = escapeHtml(`mb-${path}-${report.id}`)
  const tag = chrome ? 'h1' : 'h2'
  const docs = safeUrl(report.docsUrl)
  const code = report.code
    ? `<span class="mb-code" data-code>${docs ? `<a href="${escapeHtml(docs)}" target="_blank" rel="noreferrer" title="Documentation for ${escapeHtml(report.code)}">${escapeHtml(report.code)}${ICONS.open}<span class="mb-sr-only"> documentation (opens in a new tab)</span></a>` : escapeHtml(report.code)}</span>`
    : ''
  return `<article class="mb-report" data-kind="${escapeHtml(report.kind)}" aria-labelledby="${id}-name ${id}-message">
  <div class="mb-report-heading"><p class="mb-kicker"><span class="mb-name" id="${id}-name" data-name>${escapeHtml(report.name)}</span><span data-kind-label${report.kind === 'error' ? ' class="mb-sr-only"' : ''}>${report.kind === 'error' ? '' : ICONS.warning}${KIND_LABEL[report.kind]}</span>${state.environment ? `<span>·</span><span>${escapeHtml(state.environment)}</span>` : ''}${code}${report.status ? `<span data-status>HTTP ${escapeHtml(report.status)}</span>` : ''}</p>${chrome
    ? `<div class="mb-menu mb-copy" data-menu><button class="mb-tool" type="button" data-action="copy" data-copy="markdown">${ICONS.copy}Copy error</button>
        <button class="mb-tool" type="button" data-action="copy-menu" aria-expanded="false" aria-controls="mb-copy-menu" title="More copy formats" aria-label="More copy formats">${ICONS.down}</button>
        <ul class="mb-menu-list" id="mb-copy-menu" data-menu-list hidden>
          <li><button type="button" data-action="copy" data-copy="markdown">${ICONS.copy}Copy as Markdown</button></li>
          <li><button type="button" data-action="copy" data-copy="prompt">${ICONS.logs}Copy prompt for an agent</button></li>
          <li><button type="button" data-action="copy" data-copy="json">${ICONS.file}Copy structured JSON</button></li>
        </ul>
      </div>`
    : ''}</div>
  <${tag} class="mb-message" id="${id}-message" data-message>${escapeHtml(report.message || report.name)}</${tag}>
  ${report.hint ? `<p class="mb-hint" data-hint>${escapeHtml(report.hint)}${docs ? ` <a href="${escapeHtml(docs)}" target="_blank" rel="noreferrer">Learn more</a>` : ''}</p>` : ''}
  ${chrome ? renderCauseNavigation(state, path) : ''}
  ${renderFrames(report.frames, state, id)}
  ${report.trace?.length ? `<details class="mb-disclosure"><summary>${ICONS.chevron}Component trace <span class="mb-count">${report.trace.length}</span></summary>${renderTrace(report, state)}</details>` : ''}
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
  if (!frames.length)
    return '<p class="mb-unavailable">No stack trace was provided. The error message and request context are still available to copy.</p>'
  const origin = Math.max(0, frames.findIndex(frame => frame.type === 'app' && (frame.snippet || frame.compiled?.snippet)))
  const framework = frames.filter(frame => frame.type !== 'app').length
  const frameRow = (frame: Frame, index: number) => index === origin
    ? index === 0 ? '' : `<li class="mb-frame-reference">${escapeHtml(frame.function ?? '<anonymous>')} · Shown above</li>`
    : `<li data-frame-type="${escapeHtml(frame.type)}">${renderSource(frame, state, true)}</li>`
  const rows = groupFrames(frames).map((entry) => {
    if ('app' in entry)
      return frameRow(entry.app, entry.index)
    const group = entry.group.filter(({ index }) => index !== origin)
    if (!group.length)
      return ''
    const first = group[0]!.index + 1
    const last = group.at(-1)!.index + 1
    const missing = group.every(({ frame }) => !frame.snippet && !frame.compiled?.snippet)
    return `<li class="mb-framework-group"><div class="mb-group-caption"><span>${first === last ? first : `${first} – ${last}`}</span><span>${group.length} framework frame${group.length === 1 ? '' : 's'}<span class="mb-framework-hidden"> hidden</span></span>${missing ? '<span class="mb-missing">Code not captured</span>' : ''}</div><ol class="mb-framework-frames">${group.map(({ frame, index }) => frameRow(frame, index)).join('')}</ol></li>`
  }).join('')
  return `<div class="mb-ordered-stack">${renderSource(frames[origin]!, state)}${rows ? `<section class="mb-stack" data-stack><div class="mb-stack-heading"><button type="button" data-action="stack" class="mb-stack-toggle" aria-expanded="false" aria-controls="${parent}-stack">${ICONS.chevron}Call stack <span class="mb-count">${frames.length}</span></button>${framework ? `<button type="button" class="mb-framework" role="switch" data-action="framework" aria-checked="false"><span class="mb-switch-track" aria-hidden="true"></span>Show framework frames <span class="mb-count">(${framework})</span></button>` : ''}</div><ol class="mb-frames" id="${parent}-stack" hidden>${rows}</ol></section>` : ''}</div>`
}

function renderSource(frame: Frame, state: PageState, supporting = false): string {
  const source = !!frame.snippet && frame.line !== undefined
  const generated = !!frame.compiled?.snippet && frame.compiled.line !== undefined
  const location = (target: Pick<Frame, 'file' | 'displayFile' | 'line' | 'column'>) => {
    if (!target.file)
      return `<span class="mb-loc">${escapeHtml(frame.raw ?? 'Source location unavailable')}</span>`
    const original = frame.file ? frame : target
    return `<button type="button" class="mb-loc" data-loc data-action="open"${attr('data-file', original.file)}${attr('data-line', original.line)}${attr('data-column', original.column)}${attr('title', target.file)}>${renderLocation(target, target.line, target.column, state)}</button>`
  }
  const snippet = (compiled: boolean) => {
    const target = compiled ? frame.compiled! : frame
    return target.snippet && target.line !== undefined ? renderSnippet(target.snippet, target.line, target.column, shortPath(target, state)) : '<p class="mb-unavailable">Source is unavailable at this stack location.</p>'
  }
  if (supporting && !source && !generated)
    return `<div class="mb-empty-frame"><span class="mb-function">${escapeHtml(frame.function ?? '<anonymous>')}</span>${location(frame)}</div>`
  return `<section class="mb-source"${attr('data-supporting', supporting)} data-frame${attr('data-compiled', !source && generated)} aria-label="${supporting ? 'Stack frame' : 'Error source'}"><div class="mb-source-toolbar"><div class="mb-source-location">${frame.function ? `<span class="mb-function"${attr('title', frame.function)}>${escapeHtml(frame.function)}</span>` : ''}<span data-location-source>${location(frame)}</span>${generated ? `<span data-location-compiled>${location(frame.compiled!)}</span>` : ''}</div><div class="mb-source-actions">${source && generated ? '<span class="mb-switch" role="group" aria-label="Code view"><button type="button" data-action="toggle-compiled" data-switch="source" aria-pressed="true">Source</button><button type="button" data-action="toggle-compiled" data-switch="compiled" aria-pressed="false">Compiled</button></span>' : ''}<button type="button" class="mb-tool" data-action="context" aria-label="More context" title="More context" aria-expanded="false">${ICONS.context}</button>${frame.file ? `<button type="button" class="mb-tool" data-action="open"${attr('data-file', frame.file)}${attr('data-line', frame.line)}${attr('data-column', frame.column)} title="Open original source in your editor" aria-label="Open original source in your editor">${ICONS.open}</button>` : ''}</div></div>${generated ? `<p class="mb-compiled-note">Compiled JavaScript${frame.compiled!.file === frame.file ? ' (in memory)' : ''} · Editor opens the original source location.</p>` : ''}<div data-snippet-source${attr('hidden', !source && generated)}>${snippet(false)}</div>${generated ? `<div data-snippet-compiled${attr('hidden', source)}>${snippet(true)}</div>` : ''}</section>`
}

function renderLocation(target: DisplayTarget, line: number | undefined, column: number | undefined, state: PageState): string {
  return `${escapeHtml(shortPath(target, state))}${line !== undefined ? `<span class="mb-pos">:${escapeHtml(line)}${column !== undefined ? `:${escapeHtml(column)}` : ''}</span>` : ''}`
}

function shortPath(target: string | DisplayTarget, state: PageState): string {
  return displayPath(target, state.cwd)
}

export function renderSnippet(snippet: Snippet, line: number, column?: number, label?: string): string {
  const more = line >= snippet.start && line < snippet.start + snippet.lines.length && (snippet.start < line - 3 || snippet.start + snippet.lines.length - 1 > line + 3)
  const gutter = String(snippet.start + snippet.lines.length - 1).length
  let rows = ''
  for (const [index, text] of snippet.lines.entries()) {
    const n = snippet.start + index
    const active = n === line
    rows += `<span class="mb-line${active ? ' mb-line-active' : ''}"${active ? ' data-active aria-current="true"' : ''}${more && Math.abs(n - line) > 3 ? ' data-context="true"' : ''}><span class="mb-ln" aria-hidden="true">${escapeHtml(String(n).padStart(gutter))}</span><span class="mb-src">${highlightLine(snippet, index) || ' '}${active ? renderCaret(text, column) : ''}</span></span>`
  }
  const description = `Source${label ? ` of ${label}` : ''}, line ${line} highlighted`
  return `<pre class="mb-snippet"${attr('data-more-context', more)} data-lang="${escapeHtml(snippet.lang ?? '')}" aria-label="${escapeHtml(description)}" tabindex="0"><code>${rows}</code></pre>`
}

function renderCaret(text: string, column: number | undefined): string {
  if (column === undefined || !Number.isInteger(column)) {
    return ''
  }
  const firstToken = text.search(/\S/)
  return column > (firstToken < 0 ? text.length : firstToken) && column <= text.length + 1
    ? `<span class="mb-caret" aria-hidden="true">${escapeHtml(text.slice(0, column - 1).replace(/[^\t]/g, ' '))}^</span>`
    : ''
}

function renderLogDrawer(): string {
  return `<section class="mb-logs" id="mb-logs" data-logs hidden aria-labelledby="mb-logs-title">
  <div class="mb-logs-head">
    <h2 id="mb-logs-title">Server logs</h2><span class="mb-live" data-live role="status"><span data-live-text>Dev server: connecting</span></span>
    <label class="mb-filter">Level <select data-log-filter><option value="">all</option><option value="warn">warn+</option><option value="error">error</option></select></label>
    <button class="mb-tool" type="button" data-action="clear-logs" title="Clear logs" aria-label="Clear logs">clear</button>
    <button class="mb-tool" type="button" data-action="logs" title="Close server logs" aria-label="Close server logs">${ICONS.close}</button>
  </div>
  <div class="mb-log-scroll" role="log" aria-live="off"><ol class="mb-log-list" data-log-list></ol><p class="mb-log-empty" data-log-empty>No logs received yet.</p></div>
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
  return `<article class="mb-toast" data-toast data-kind="${escapeHtml(report.kind)}" data-toast-id="${escapeHtml(report.id)}">
  ${ICONS.warning}<button type="button" class="mb-toast-body" data-action="show-toast"><strong>${escapeHtml(report.name)}</strong><span>${escapeHtml(report.message)}</span></button>
  <button type="button" class="mb-tool" data-action="dismiss-toast" title="Dismiss warning" aria-label="Dismiss warning">${ICONS.close}</button>
</article>`
}

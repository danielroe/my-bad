import type { ProblemSummary } from '../../channel/protocol'
import type { DisplayTarget } from '../../report/path'
import type { ErrorReport, Frame, HistoryEntry, Location, Section, Snippet } from '../../types'
import type { Listed, QueryKey, suggest, Suggestion } from './problems'
import type { BadgeFocus, DockedIndex, DockedState, Level, PageState } from './state'
import { plainText } from '../../report/code'
import { clampMessage, splitHeadline } from '../../report/message'
import { displayPath } from '../../report/path'
import { stringifyValue } from '../../report/stringify'
import { groupFrames } from '../frames'
import { attr, escapeHtml, inlineHtml, safeUrl } from './escape'
import { highlightLine } from './highlight'
import { calmStatus, facets, filtering, listing, nothingOpen, parseQuery, sourceTone } from './problems'
import { DOCKED_TITLE } from './state'
import { countsLabel, dockedCounts, firstLine, plural, repeatsLabel, reportLocation, warningCount } from './summary'

export const ICONS = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6v20h12V6zM14 2v6h4M9 13h6m-6 4h6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  context: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 4-4 4 4M12 4v6m-4 6 4 4 4-4m-4 4v-6M4 12h16"/></svg>',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v3a4 4 0 0 1-4 4H6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>',
  logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  checking: '<svg class="mb-spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
}

const KIND_LABEL = {
  error: 'Error',
  warning: 'Warning',
  compile: 'Compile error',
  info: 'Info',
}
/** Names that only restate the kind, which the row's icon already shows. */
const GENERIC_NAMES = new Set(Object.values(KIND_LABEL).map(label => label.toLowerCase()))
const KIND_NOUN = {
  error: 'error',
  warning: 'warning',
  compile: 'error',
  info: 'problem',
}
const KIND_ICON = {
  error: ICONS.error,
  warning: ICONS.warning,
  compile: ICONS.error,
  info: ICONS.info,
}

function headerCount(report: ErrorReport): string {
  if (report.kind !== 'error') {
    return KIND_LABEL[report.kind]
  }
  const count = reportEntries(report).filter(entry => entry.related).length + 1
  return `${count} error${count === 1
    ? ''
    : 's'}`
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
  <nav class="mb-tools" aria-label="${report.kind === 'warning'
    ? 'Tools'
    : 'Error page tools'}">
    <ul>
      ${renderPager(report, state.history)}
      <li><span class="mb-warning-count" data-warning-count${attr('hidden', !warningCount(state.history))}>${warningLabel(state.history)}</span></li>

      <li><button class="mb-tool" type="button" data-action="theme" title="Toggle colour scheme" aria-label="Toggle colour scheme">${ICONS.theme}</button></li>
      ${state.mode === 'overlay'
        ? `<li><button class="mb-tool" type="button" data-action="minimize" title="Minimise (show the page behind)" aria-label="Minimise overlay and show the page behind">${ICONS.minimize}</button></li>`
        : ''}
    </ul>
  </nav>
  ${live ? '<div class="mb-progress" data-progress hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Build progress"><div class="mb-progress-bar"></div><span class="mb-progress-label" data-progress-label></span></div>' : ''}
</header>
<div class="mb-sr-only" role="status" aria-live="polite" data-announce></div>
<main class="mb-main" data-report-id="${escapeHtml(report.id)}" tabindex="-1">
  ${renderReport(reportEntries(report).find(entry => entry.path === selected)?.report ?? report, state, selected)}
  ${renderFallback(state, selected)}
  <div class="mb-secondary">${renderSecondaryTools(report, live)}${renderHistory(report, state.history)}</div>
</main>
${live
  ? renderLogDrawer()
  : ''}
${report.sections.length
  ? renderInfoDialog(report.sections)
  : ''}
<section class="mb-toasts" data-toasts aria-live="polite" aria-label="Warnings"></section>`
}

function renderSecondaryTools(report: ErrorReport | undefined, live: boolean): string {
  return `${report?.sections.length
    ? `<button class="mb-tool" type="button" data-action="info">${ICONS.info}Request &amp; environment</button>`
    : ''}${live
    ? `<button class="mb-tool mb-tool-logs" type="button" data-action="logs" aria-pressed="false" aria-controls="mb-logs" title="Server logs" aria-label="Server logs">${ICONS.logs}Logs<span class="mb-badge" data-log-count hidden></span></button>`
    : ''}`
}

function failed(set: ProblemSummary): boolean {
  return set.status === 'failed'
}

/** Open errors, warnings and info, with failed sources counted apart. */
export function dockedSummary(index: DockedIndex): string {
  const broken = index.problems.filter(failed).length
  const counts = dockedCounts(index)
  return [
    countsLabel({
      errors: counts.errors - broken,
      warnings: counts.warnings,
      info: index.problems.reduce((total, set) => total + (failed(set)
        ? 0
        : set.info ?? 0), 0),
    }),
    broken && `${plural(broken, 'check')} failed`,
  ].filter(Boolean).join(' · ') || (index.problems.some(set => set.status === 'checking')
    ? 'Checking'
    : 'All clear')
}

function renderIndexItem(entry: Pick<HistoryEntry, 'id' | 'kind' | 'name' | 'message' | 'codeSpans'>, location: string, shown: BadgeFocus | undefined, source?: string, heading?: string): string {
  const current = shown?.id === entry.id && shown.source === source
  const message = inlineHtml(firstLine(entry.message), entry.codeSpans)
  const title = repeatsLabel(entry.name, heading) || GENERIC_NAMES.has(entry.name.toLowerCase())
    ? message
    : `${escapeHtml(entry.name)}: ${message}`
  return `<li><button type="button" class="mb-index-item" data-action="select" data-kind="${escapeHtml(entry.kind)}" data-id="${escapeHtml(entry.id)}"${attr('data-source', source)} aria-current="${current}">${KIND_ICON[entry.kind]}<span class="mb-index-title">${title}</span>${location
    ? `<span class="mb-index-loc">${escapeHtml(location)}</span>`
    : ''}</button></li>`
}

function indexLocation(report: ErrorReport, state: Pick<PageState, 'cwd'>): string {
  const frame = reportLocation(report)
  return frame?.file
    ? `${displayPath(frame, state.cwd)}${frame.line === undefined
      ? ''
      : `:${frame.line}${frame.column === undefined
        ? ''
        : `:${frame.column}`}`}`
    : ''
}

function renderIndexSet(set: DockedIndex['problems'][number], state: DockedState, shown: BadgeFocus | undefined): string {
  const url = safeUrl(set.url)
  const status = failed(set)
    ? `failed${set.error
      ? `: ${set.error}`
      : ''}`
    : String(set.reports?.length ?? set.errors + set.warnings + (set.info ?? 0))
  const reports = set.reports ?? []
  const listed = shown?.list && shown.source === set.source
  return `<section class="mb-index-group" data-index-source="${escapeHtml(set.source)}"${attr('data-focused', shown?.source === set.source && !shown.id)}><h2>${set.status === 'checking'
    ? ICONS.checking
    : ''}<span class="mb-index-label">${escapeHtml(set.group
    ? `${set.group} · ${set.label ?? set.source}`
    : set.label ?? set.source)}</span>${status
    ? `<span class="mb-count${failed(set)
      ? ' mb-status'
      : ''}">${escapeHtml(status)}</span>`
    : ''}${url || (set.devtoolsDock && state.docks)
    ? `<button type="button" class="mb-index-list" data-action="list" data-source="${escapeHtml(set.source)}" title="Show the full list" aria-label="Show the full list" aria-pressed="${!!listed}">${ICONS.list}</button>`
    : ''}</h2>${reports.length
    ? `<ul>${reports.map(report => renderIndexItem(report, indexLocation(report, state), shown, set.source, set.label ?? set.source)).join('')}</ul>`
    : ''}</section>`
}

const TONE_ICON = {
  busy: ICONS.checking,
  error: ICONS.error,
  warning: ICONS.warning,
  ok: ICONS.check,
}

interface FileEntry {
  entry: Listed
  source?: string
  label: string
}

function renderByFile(entries: FileEntry[], state: DockedState, shown: BadgeFocus | undefined): string[] {
  const files = new Map<string, Array<FileEntry & { frame?: Frame }>>()
  for (const item of entries) {
    const frame = 'frames' in item.entry
      ? reportLocation(item.entry)
      : undefined
    const key = frame?.file ?? ''
    files.set(key, [
      ...files.get(key) ?? [],
      { ...item, frame },
    ])
  }
  return [...files].map(([file, items]) => ({
    file,
    path: items[0]!.frame?.file
      ? displayPath(items[0]!.frame, state.cwd)
      : '',
    items,
  })).sort((a, b) => !a.file === !b.file
    ? a.path.localeCompare(b.path)
    : a.file
      ? -1
      : 1).map(({ file, path, items }) => {
    const rows = items
      .sort((a, b) => (a.frame?.line ?? 0) - (b.frame?.line ?? 0) || (a.frame?.column ?? 0) - (b.frame?.column ?? 0))
      .map(({ entry, source, label, frame }) => {
        const position = frame?.line === undefined
          ? ''
          : `${frame.line}${frame.column === undefined
            ? ''
            : `:${frame.column}`}`
        return renderIndexItem(entry, [source && label, position].filter(Boolean).join(' · '), shown, source, source && label)
      })
    return `<section class="mb-index-group" data-index-file="${escapeHtml(file)}"><h2><span class="mb-index-label"${attr('title', path || undefined)}>${path
      ? `&lrm;${escapeHtml(path)}&lrm;`
      : 'No file'}</span><span class="mb-count">${items.length}</span></h2><ul>${rows.join('')}</ul></section>`
  })
}

const LEVEL_LABEL = { error: 'Errors', warning: 'Warnings', info: 'Info' }

/**
 * The level tabs above the list. A tab sets the `is:` token of the query, or clears it for All, so the field keeps
 * the whole filter. Counts are what each tab would list given the rest of the query. With one level, there is nothing to pick.
 */
function renderTabs(state: DockedState, index: DockedIndex): string {
  const view = state.view ?? {}
  const { levels } = facets(index, view, state.cwd)
  const picked = parseQuery(view.filter).is.include
  const only = picked.length === 1
    ? picked[0]
    : undefined
  const shown = levels.filter(({ level, count }) => count || only === level)
  const byFile = view.group === 'file'
  // Grouping changes the list right below it, so it sits at the end of the bar above the list.
  const group = `<button type="button" class="mb-tab-tool" data-action="group" aria-pressed="${byFile}" title="Group by file" aria-label="Group by file">${ICONS.file}</button>`
  const tab = (level: string, label: string, count: number, active: boolean) => `<button type="button" class="mb-tab" data-action="level" data-level="${level}" aria-pressed="${active}">${escapeHtml(label)} <span class="mb-tab-count">${count}</span></button>`
  const tabs = shown.length > 1 || only
    ? `<div class="mb-tab-list" role="group" aria-label="Show">${[
      tab('all', 'All', levels.reduce((sum, { count }) => sum + count, 0), !picked.length),
      ...shown.map(({ level, count }) => tab(level, LEVEL_LABEL[level], count, only === level)),
    ].join('')}</div>`
    : ''
  return `<div class="mb-tabs">${tabs}${group}</div>`
}

const SUGGEST_TITLE = { is: 'Level', source: 'Source', file: 'File' }

/** The filters the search field offers, as options of its listbox. `active` is the option the keyboard is on. */
export function renderSuggestions(result: ReturnType<typeof suggest>, active: number): string {
  let position = 0
  const option = (key: QueryKey, item: Suggestion) => {
    const at = position++
    const token = `${result.negate ? '-' : ''}${item.token}`
    const icon = key === 'is'
      ? KIND_ICON[item.value as Level]
      : key === 'source'
        ? TONE_ICON[item.tone ?? 'ok']
        : ICONS.file
    // A path keeps its end in view, so it is cut from the start: the marks keep its slashes in place.
    const label = key === 'file'
      ? `&lrm;${escapeHtml(item.label)}&lrm;`
      : escapeHtml(key === 'is'
          ? LEVEL_LABEL[item.value as Level]
          : item.label)
    const shownToken = key === 'file'
      ? ''
      : `<code class="mb-suggest-token">${escapeHtml(token)}</code>`
    return `<div class="mb-suggest-item" role="option" id="mb-suggest-${at}" data-action="suggest" data-token="${escapeHtml(token)}" data-key="${key}"${attr('data-tone', item.tone)}${attr('data-level', key === 'is'
      ? item.value
      : undefined)} aria-selected="${at === active}">${icon}<span class="mb-suggest-label"${attr('title', key === 'file'
      ? item.label
      : undefined)}>${label}</span>${shownToken}<span class="mb-suggest-count">${item.count}</span></div>`
  }
  return `${result.groups.map(({ key, items }) => `<div class="mb-suggest-group" role="group" aria-label="${SUGGEST_TITLE[key]}"><p class="mb-suggest-title" aria-hidden="true">${SUGGEST_TITLE[key]}</p>${items.map(item => option(key, item)).join('')}</div>`).join('')}<p class="mb-suggest-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> pick <kbd>↵</kbd> add <span>·</span> start with <kbd>-</kbd> to leave out</p>`
}

/** The list beside a docked view, of the open error, the warnings and every problem set. */
export function renderIndex(state: DockedState, index: DockedIndex, shown?: BadgeFocus): string {
  const view = state.view ?? {}
  const { all, current, warnings: shownWarnings, sets: listedSets } = listing(index, view, state.cwd)
  const groups = [
    current && `<section class="mb-index-group"><h2><span class="mb-index-label">Error</span></h2><ul>${renderIndexItem(current, indexLocation(current, state), shown)}</ul></section>`,
    shownWarnings.length && `<section class="mb-index-group"><h2><span class="mb-index-label">Warnings</span><span class="mb-count">${shownWarnings.length}</span></h2><ul>${shownWarnings.map(entry => renderIndexItem(entry, '', shown)).join('')}</ul></section>`,
    ...listedSets.map(set => renderIndexSet(set, state, shown)),
  ].filter(Boolean)
  if (view.group === 'file') {
    groups.splice(0, groups.length, ...renderByFile([
      ...current
        ? [
            { entry: current as Listed, label: 'Error' },
          ]
        : [],
      ...shownWarnings.map(entry => ({ entry, label: 'Warning' })),
      ...listedSets.flatMap(set => (set.reports ?? []).map(entry => ({ entry, source: set.source, label: set.label ?? set.source }))),
    ], state, shown))
  }
  return `<nav class="mb-index" data-index aria-label="Errors, warnings and problems">${all.length
    ? renderTabs(state, index)
    : ''}${groups.length
    ? groups.join('')
    : filtering(view)
      ? `<div class="mb-index-empty"><p class="mb-index-empty-title">Nothing matches <code>${escapeHtml(view.filter!.trim())}</code></p><button type="button" class="mb-index-reset" data-action="show-all">Clear the filter</button></div>`
      : '<p class="mb-index-empty">Nothing to report.</p>'}</nav>`
}

/** What a docked view shows while nothing is open: a calm state, and what each source is doing. */
export function renderCalm(state: DockedState, index: DockedIndex): string {
  const now = state.view?.now ?? Date.now()
  const broken = index.problems.filter(failed).length
  const checking = index.problems.some(set => set.status === 'checking')
  return `<div class="mb-docked-calm" data-calm${attr('data-failed', !!broken)}>${broken
    ? ICONS.error
    : checking
      ? ICONS.checking
      : ICONS.check}<p class="mb-docked-empty-title">${broken
    ? broken === 1
      ? 'A check failed'
      : `${broken} checks failed`
    : checking
      ? 'Checking for problems'
      : 'No problems'}</p><p>Errors, warnings and problems from the dev server show up here as they happen.</p>${index.problems.length
    ? `<ul class="mb-watched" aria-label="Sources">${index.problems.map((set) => {
      const tone = sourceTone(set)
      return `<li data-tone="${tone}">${failed(set)
        ? ICONS.close
        : TONE_ICON[tone]}<span class="mb-watched-label">${escapeHtml(set.label ?? set.source)}</span><span class="mb-watched-status">${escapeHtml(calmStatus(set, now))}</span></li>`
    }).join('')}</ul>`
    : ''}</div>`
}

export function renderUnselected(state: DockedState, index: DockedIndex, shown: BadgeFocus | undefined): string {
  const set = shown?.source === undefined
    ? undefined
    : index.problems.find(entry => entry.source === shown.source)
  return set
    ? `<div class="mb-docked-empty" data-unselected><p class="mb-docked-empty-title">${escapeHtml(set.label ?? set.source)}</p><p>${escapeHtml(calmStatus(set, state.view?.now ?? Date.now()))}</p></div>`
    : '<div class="mb-docked-empty" data-unselected><p>Select an entry in the list to see it here.</p></div>'
}

/** A docked view: the index of everything open, and the report it has selected rendered as the overlay renders it. */
export function renderDocked(state: DockedState, index: DockedIndex, report?: ErrorReport, shown?: BadgeFocus, selected = 'r'): string {
  const live = !!state.channel
  const view = report && { ...state, mode: 'docked' as const, report }
  const set = shown?.list
    ? index.problems.find(entry => entry.source === shown.source)
    : undefined
  const list = safeUrl(set?.url)
  const calm = nothingOpen(index)
  return `<header class="mb-header mb-corners">
  <div class="mb-brand-group"><p class="mb-docked-title">${escapeHtml(state.title || DOCKED_TITLE)}</p><span class="mb-header-count" data-docked-count>${escapeHtml(dockedSummary(index))}</span></div>
  <nav class="mb-tools" aria-label="Tools"><ul>${calm
    ? ''
    : `<li><button class="mb-tool" type="button" data-action="copy-listed" title="Copy the problems listed as Markdown" aria-label="Copy the problems listed as Markdown">${ICONS.copy}</button></li>`}${state.drawer
    ? `<li><button class="mb-tool" type="button" data-action="close-docked" title="Close" aria-label="Close">${ICONS.close}</button></li>`
    : ''}</ul></nav>
  ${live ? '<div class="mb-progress" data-progress hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Build progress"><div class="mb-progress-bar"></div><span class="mb-progress-label" data-progress-label></span></div>' : ''}
</header>
<div class="mb-sr-only" role="status" aria-live="polite" data-announce></div>
<div class="mb-docked"${attr('data-calm-view', calm)}>
${calm
  ? ''
  : `<div class="mb-index-pane"><div class="mb-index-filter"><div class="mb-query">${ICONS.search}<input type="search" data-filter placeholder="Filter problems" aria-label="Filter problems" role="combobox" aria-autocomplete="list" aria-controls="mb-suggest" aria-expanded="false" autocomplete="off" spellcheck="false"${attr('value', state.view?.filter || undefined)}><button type="button" class="mb-query-clear" data-action="show-all" title="Clear the filter" aria-label="Clear the filter">${ICONS.close}</button></div><div class="mb-suggest" id="mb-suggest" role="listbox" aria-label="Filters" data-suggest hidden></div></div>${renderIndex(state, index, shown)}</div>`}
<main class="mb-main"${attr('data-report-id', report?.id)}${attr('data-list', !!list)} tabindex="-1">
  ${list
    ? `<p class="mb-docked-list-bar"><a href="${escapeHtml(list)}" target="_blank" rel="noreferrer">Open in a new tab${ICONS.open}</a></p><iframe class="mb-docked-list" src="${escapeHtml(list)}" title="${escapeHtml(`${set!.label ?? set!.source}: full list`)}"></iframe>`
    : view
      ? `${renderReport(reportEntries(view.report).find(entry => entry.path === selected)?.report ?? view.report, view, selected)}
  ${renderFallback(view, selected)}`
      : state.withheld && shown?.source && index.problems.some(entry => entry.source === shown.source && entry.errors + entry.warnings)
        ? '<div class="mb-docked-empty"><p class="mb-docked-empty-title">Problems listed on the dev machine</p><p>The dev server only lists problems on its own machine. Open this page there to see them.</p></div>'
        : calm
          ? renderCalm(state, index)
          : renderUnselected(state, index, shown)}
  <div class="mb-secondary">${renderSecondaryTools(report, live)}</div>
</main>
</div>
${live
  ? renderLogDrawer()
  : ''}
${report?.sections.length
  ? renderInfoDialog(report.sections)
  : ''}`
}

export { warningCount }

export function warningLabel(history: HistoryEntry[] | undefined): string {
  const count = warningCount(history)
  return count
    ? `${count} warning${count === 1
      ? ''
      : 's'}`
    : ''
}

/** Position of the shown report in the history, falling back to the first entry when the history has dropped it. */
export function pagerIndex(report: ErrorReport, history: HistoryEntry[]): number {
  return Math.max(0, history.findIndex(entry => entry.id === report.id))
}

export function renderHistoryItems(report: ErrorReport, history: HistoryEntry[]): string {
  const index = pagerIndex(report, history)
  return history.map((entry, position) => `<li><button type="button" data-entry="${escapeHtml(entry.id)}" data-action="history" data-dir="${position - index}">${inlineHtml(firstLine(entry.message), entry.codeSpans)}</button></li>`).join('')
}

export function renderHistory(report: ErrorReport, history?: HistoryEntry[]): string {
  return history?.length
    ? `<details class="mb-history"><summary>${ICONS.history}History</summary><ol>${renderHistoryItems(report, history)}</ol></details>`
    : ''
}

export function renderPager(report: ErrorReport, history?: HistoryEntry[]): string {
  if (!history || history.length < 2) {
    return `<li class="mb-pager" data-pager hidden></li>`
  }
  const index = pagerIndex(report, history)
  const [group, noun] = report.kind === 'warning'
    ? ['History', 'report']
    : ['Error history', 'error']
  return `<li class="mb-pager" data-pager><span role="group" aria-label="${group}">
    <button class="mb-tool" type="button" data-action="history" data-dir="-1"${attr('disabled', index <= 0)} title="Previous ${noun}" aria-label="Previous ${noun}">${ICONS.prev}</button>
    <span data-pager-label>${index + 1} of ${history.length}</span>
    <button class="mb-tool" type="button" data-action="history" data-dir="1"${attr('disabled', index >= history.length - 1)} title="Next ${noun}" aria-label="Next ${noun}">${ICONS.next}</button>
  </span></li>`
}

export function reportEntries(report: ErrorReport, path = 'r', related = false): Array<{ report: ErrorReport, path: string, label: string, related: boolean }> {
  return [
    {
      report,
      path,
      related,
      label: path === 'r'
        ? 'Reported error'
        : related
          ? 'Related error'
          : report.causes.length ? 'Wrapped error' : 'Root cause',
    },
    ...report.causes.flatMap((cause, index) => reportEntries(cause, `${path}c${index}`, related)),
    ...(report.errors ?? []).flatMap((error, index) => reportEntries(error, `${path}e${index}`, true)),
  ]
}

function renderCauseNavigation(state: PageState, selected: string): string {
  const entries = reportEntries(state.report)
  if (entries.length < 2)
    return ''
  const related = entries.some(entry => entry.related)
  const chain = related
    ? entries
    : entries.reverse()
  const current = chain.findIndex(entry => entry.path === selected)
  const message = (report: ErrorReport) => inlineHtml(firstLine(report.message), report.codeSpans)
  const entry = (index: number, html = escapeHtml(chain[index]!.label)) => `<button type="button" data-action="cause" data-path="${chain[index]!.path}" aria-current="${index === current}" title="${escapeHtml(plainText(chain[index]!.report.message, chain[index]!.report.codeSpans))}">${html}</button>`
  if (chain.length === 2 && !related) {
    return `<nav class="mb-single-cause" aria-label="Error cause">${selected === 'r'
      ? `Caused by ${entry(0, message(chain[0]!.report))}`
      : entry(1, `Back to: ${message(state.report)}`)}</nav>`
  }
  return `<nav class="mb-causes" aria-label="${related ? 'Related errors' : 'Error cause chain'}"><div class="mb-cause-path">${entry(0, escapeHtml(`1 ${chain[0]!.label}`))}<details class="mb-cause-picker"><summary>${current > 0 && current < chain.length - 1
    ? `${current + 1} ${chain[current]!.label}`
    : related
      ? `${chain.length - 1} related errors`
      : 'Wrapped errors'}${ICONS.down}</summary><ol>${chain.map((item, index) => `<li>${entry(index, `${escapeHtml(`${index + 1} ${item.label}`)}: ${message(item.report)}`)}</li>`).join('')}</ol></details>${related
    ? ''
    : `${ICONS.chevron}${entry(chain.length - 1, escapeHtml(`${chain.length} Reported error`))}`}</div><p>Inspecting ${chain[current]?.label.toLowerCase()} · ${current + 1} of ${chain.length}${selected !== 'r'
    ? `<span>Reported as: ${message(state.report)}</span>`
    : ''}</p></nav>`
}

/** Causes and related errors in full, for when the picker's client script is unavailable. */
function renderFallback(state: PageState, selected: string): string {
  const all = reportEntries(state.report)
  const rest = all.filter(entry => entry.path !== selected)
  if (!rest.length) {
    return ''
  }
  const omitted = all.reduce((total, entry) => total + (entry.report.omittedErrors ?? 0), 0)
  const note = omitted
    ? `<p class="mb-fallback-label">and ${escapeHtml(omitted)} more related ${omitted === 1
      ? 'error'
      : 'errors'} not shown</p>`
    : ''
  return `<details class="mb-disclosure mb-fallback" data-fallback><summary>${ICONS.chevron}${rest.length === 1
    ? 'Cause'
    : 'Causes and related errors'} <span class="mb-count">${rest.length}</span></summary>${rest.map(entry => `<section class="mb-fallback-entry"><p class="mb-fallback-label">${escapeHtml(entry.label)}</p>${renderReport(entry.report, state, entry.path, false)}</section>`).join('')}${note}</details>`
}

function renderReport(report: ErrorReport, state: PageState, path: string, chrome = true): string {
  const id = escapeHtml(`mb-${path}-${report.id}`)
  const tag = chrome ? 'h1' : 'h2'
  const docs = safeUrl(report.docsUrl)
  const selfCoded = report.name === report.code
  const code = report.code
    ? `<span class="mb-code" data-code>${docs
      ? `<a href="${escapeHtml(docs)}" target="_blank" rel="noreferrer" title="Documentation for ${escapeHtml(report.code)}">${escapeHtml(report.code)}${ICONS.open}<span class="mb-sr-only"> documentation (opens in a new tab)</span></a>`
      : escapeHtml(report.code)}</span>`
    : ''
  return `<article class="mb-report" data-kind="${escapeHtml(report.kind)}" aria-labelledby="${id}-name ${id}-message">
  <div class="mb-report-heading"><p class="mb-kicker">${report.kind === 'error'
    ? ''
    : `<span class="mb-kind-icon" aria-hidden="true">${report.kind === 'info'
      ? ICONS.info
      : ICONS.warning}</span>`}<span class="mb-name" id="${id}-name" data-name>${escapeHtml(selfCoded ? KIND_LABEL[report.kind] : report.name)}</span>${selfCoded
    ? ''
    : `${report.kind === 'error'
      ? ''
      : '<span aria-hidden="true">·</span>'}<span data-kind-label${report.kind === 'error'
      ? ' class="mb-sr-only"'
      : ''}>${KIND_LABEL[report.kind]}</span>`}${state.environment
    ? `<span>·</span><span>${escapeHtml(state.environment)}</span>`
    : ''}${code}${report.status
    ? `<span data-status>HTTP ${escapeHtml(report.status)}</span>`
    : ''}</p>${chrome
    ? `<div class="mb-menu mb-copy" data-menu><button class="mb-tool" type="button" data-action="copy" data-copy="markdown">${ICONS.copy}Copy ${KIND_NOUN[report.kind]}</button>
        <button class="mb-tool" type="button" data-action="copy-menu" aria-expanded="false" aria-controls="mb-copy-menu" title="More copy formats" aria-label="More copy formats">${ICONS.down}</button>
        <ul class="mb-menu-list" id="mb-copy-menu" data-menu-list hidden>
          <li><button type="button" data-action="copy" data-copy="markdown">${ICONS.copy}Copy as Markdown</button></li>
          <li><button type="button" data-action="copy" data-copy="prompt">${ICONS.logs}Copy prompt for an agent</button></li>
          <li><button type="button" data-action="copy" data-copy="json">${ICONS.file}Copy structured JSON</button></li>
        </ul>
      </div>`
    : ''}</div>
  ${renderMessage(report, state, tag, `${id}-message`)}
  ${report.hint
    ? `<p class="mb-hint" data-hint>${inlineHtml(report.hint, report.codeSpans)}${docs
      ? ` <a href="${escapeHtml(docs)}" target="_blank" rel="noreferrer">Learn more</a>`
      : ''}</p>`
    : ''}
  ${chrome
    ? renderCauseNavigation(state, path)
    : ''}
  ${renderFrames(report.frames, report.related, state, id)}
  ${report.trace?.length
    ? `<details class="mb-disclosure"><summary>${ICONS.chevron}Component trace <span class="mb-count">${report.trace.length}</span></summary>${renderTrace(report, state)}</details>`
    : ''}
</article>`
}

function renderMessage(report: ErrorReport, state: PageState, tag: string, id: string): string {
  const { head, rest } = clampMessage(report.message || report.name, state.maxMessageLength)
  const { headline, body } = splitHeadline(head)
  const more = rest
    ? `<span class="mb-message-rest" data-message-rest hidden>${inlineHtml(rest, report.codeSpans)}</span><button type="button" class="mb-message-more" data-action="expand-message">Show full message <span class="mb-count">${rest.length} more characters</span></button>`
    : ''
  const text = rest
    ? body
    : body.trimEnd()
  return text
    ? `<${tag} class="mb-message" id="${id}" data-message>${inlineHtml(headline, report.codeSpans)}</${tag}><p class="mb-message-body" data-message-body>${inlineHtml(text, report.codeSpans)}${more}</p>`
    : `<${tag} class="mb-message" id="${id}" data-message>${inlineHtml(headline, report.codeSpans)}${more}</${tag}>`
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

function renderRelated(related: Location[] | undefined, state: PageState): string {
  return related?.length
    ? `<section class="mb-related" aria-label="Also in"><p class="mb-related-heading" aria-hidden="true">Also in</p><ul>${related.map(entry => `<li class="mb-empty-frame"><button type="button" class="mb-loc" data-loc data-action="open"${positionAttrs('data-', entry)}${attr('title', entry.file)}>${renderLocation(entry, entry.line, entry.column, state)}</button>${renderCopyLocation(entry, false)}</li>`).join('')}</ul></section>`
    : ''
}

function renderFrames(frames: Frame[], related: Location[] | undefined, state: PageState, parent: string): string {
  if (!frames.length) {
    return `<p class="mb-unavailable">No stack trace was provided. The ${KIND_NOUN[state.report.kind]} message and request context are still available to copy.</p>${related?.length
      ? `<div class="mb-ordered-stack">${renderRelated(related, state)}</div>`
      : ''}`
  }
  const origin = isLocation(frames[0]!)
    ? 0
    : Math.max(0, frames.findIndex(frame => frame.type === 'app' && (frame.snippet || frame.compiled?.snippet)))
  const framework = frames.filter(frame => frame.type !== 'app').length
  const frameRow = (frame: Frame, index: number) => index === origin
    ? index === 0
      ? ''
      : `<li class="mb-frame-reference">${escapeHtml(frame.function ?? '<anonymous>')} · Shown above</li>`
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
    return `<li class="mb-framework-group"><div class="mb-group-caption"><span>${first === last
      ? first
      : `${first} – ${last}`}</span><span>${group.length} framework frame${group.length === 1
      ? ''
      : 's'}<span class="mb-framework-hidden"> hidden</span></span>${missing ? '<span class="mb-missing">Code not captured</span>' : ''}</div><ol class="mb-framework-frames">${group.map(({ frame, index }) => frameRow(frame, index)).join('')}</ol></li>`
  }).join('')
  return `<div class="mb-ordered-stack">${renderSource(frames[origin]!, state)}${renderRelated(related, state)}${rows
    ? `<section class="mb-stack" data-stack><div class="mb-stack-heading"><button type="button" data-action="stack" class="mb-stack-toggle" aria-expanded="false" aria-controls="${parent}-stack">${ICONS.chevron}Call stack <span class="mb-count">${frames.length}</span></button>${framework
      ? `<button type="button" class="mb-framework" role="switch" data-action="framework" aria-checked="false"><span class="mb-switch-track" aria-hidden="true"></span>Show framework frames <span class="mb-count">(${framework})</span></button>`
      : ''}</div><ol class="mb-frames" id="${parent}-stack" hidden>${rows}</ol></section>`
    : ''}</div>`
}

/** A location the report names itself, such as a `sources` entry, rather than a stack frame. */
function isLocation(frame: Frame): boolean {
  return frame.type === 'app' && !!frame.file && !frame.raw && !frame.function
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
    return target.snippet && target.line !== undefined
      ? renderSnippet(target.snippet, target.line, target.column, shortPath(target, state), compiled
          ? undefined
          : frame)
      : '<p class="mb-unavailable">Source is unavailable at this stack location.</p>'
  }
  const copy = renderCopyLocation(frame, generated)
  const fileOnly = !!frame.file && !frame.compiled && !frame.snippet && (frame.line === undefined || isLocation(frame))
  if (supporting && !source && !generated) {
    return `<div class="mb-empty-frame">${fileOnly && !frame.function
      ? ''
      : `<span class="mb-function">${escapeHtml(frame.function ?? '<anonymous>')}</span>`}${location(frame)}${copy}</div>`
  }
  return `<section class="mb-source"${attr('data-supporting', supporting)} data-frame${attr('data-compiled', !source && generated)}${attr('data-file-only', fileOnly)} aria-label="${supporting
    ? 'Stack frame'
    : `${state.report.kind === 'warning'
      ? 'Warning'
      : state.report.kind === 'info'
        ? 'Problem'
        : 'Error'} source`}"><div class="mb-source-toolbar"><div class="mb-source-location">${frame.function
    ? `<span class="mb-function"${attr('title', frame.function)}>${escapeHtml(frame.function)}</span>`
    : ''}<span data-location-source>${location(frame)}</span>${generated
    ? `<span data-location-compiled>${location(frame.compiled!)}</span>`
    : ''}</div><div class="mb-source-actions">${source && generated
    ? '<span class="mb-switch" role="group" aria-label="Code view"><button type="button" data-action="toggle-compiled" data-switch="source" aria-pressed="true">Source</button><button type="button" data-action="toggle-compiled" data-switch="compiled" aria-pressed="false">Compiled</button></span>'
    : ''}<button type="button" class="mb-tool" data-action="context" aria-label="More context" title="More context" aria-expanded="false">${ICONS.context}</button>${copy}${frame.file
    ? `<button type="button" class="mb-tool" data-action="open"${attr('data-file', frame.file)}${attr('data-line', frame.line)}${attr('data-column', frame.column)} title="Open original source in your editor" aria-label="Open original source in your editor">${ICONS.open}</button>`
    : ''}</div></div>${generated
    ? `<p class="mb-compiled-note">Compiled JavaScript${frame.compiled!.file === frame.file
      ? ' (in memory)'
      : ''} · Editor opens the original source location.</p>`
    : ''}${fileOnly
    ? ''
    : `<div data-snippet-source${attr('hidden', !source && generated)}>${snippet(false)}</div>`}${generated
    ? `<div data-snippet-compiled${attr('hidden', source)}>${snippet(true)}</div>`
    : ''}</section>`
}

function positionAttrs(prefix: string, target: Pick<Frame, 'file' | 'line' | 'column'> | undefined): string {
  return target?.file
    ? `${attr(`${prefix}file`, target.file)}${attr(`${prefix}line`, target.line)}${attr(`${prefix}column`, target.column)}`
    : ''
}

function renderCopyLocation(frame: Pick<Frame, 'file' | 'line' | 'column' | 'compiled'>, generated: boolean): string {
  if (!frame.file && !(generated && frame.compiled?.file)) {
    return ''
  }
  return `<button type="button" class="mb-tool" data-action="copy-location"${positionAttrs('data-', frame)}${generated
    ? positionAttrs('data-compiled-', frame.compiled)
    : ''} title="Copy location" aria-label="Copy location">${ICONS.copy}</button>`
}

function renderLocation(target: DisplayTarget, line: number | undefined, column: number | undefined, state: PageState): string {
  return `${escapeHtml(shortPath(target, state))}${line !== undefined
    ? `<span class="mb-pos">:${escapeHtml(line)}${column !== undefined
      ? `:${escapeHtml(column)}`
      : ''}</span>`
    : ''}`
}

function shortPath(target: string | DisplayTarget, state: PageState): string {
  return displayPath(target, state.cwd)
}

export function renderSnippet(snippet: Snippet, line: number, column?: number, label?: string, end?: Pick<Frame, 'endLine' | 'endColumn'>): string {
  const more = line >= snippet.start && line < snippet.start + snippet.lines.length && (snippet.start < line - 3 || snippet.start + snippet.lines.length - 1 > line + 3)
  const gutter = String(snippet.start + snippet.lines.length - 1).length
  const offset = snippet.offset ?? 0
  const multiline = end?.endLine !== undefined && end.endLine > line
  const endLine = multiline
    ? end!.endLine! - (end!.endColumn === 1
      ? 1
      : 0)
    : line
  let rows = ''
  for (const [index, text] of snippet.lines.entries()) {
    const n = snippet.start + index
    const active = n === line
    const ranged = n > line && n <= endLine
    const start = column === undefined
      ? undefined
      : column - offset
    const width = start === undefined
      ? 1
      : multiline
        ? text.length - start + 1
        : end?.endColumn === undefined
          ? 1
          : end.endColumn - offset - start
    rows += `<span class="mb-line${active ? ' mb-line-active' : ''}${ranged ? ' mb-line-range' : ''}"${active ? ' data-active aria-current="true"' : ''}${more && Math.abs(n - line) > 3
      ? ' data-context="true"'
      : ''}><span class="mb-ln" aria-hidden="true">${escapeHtml(String(n).padStart(gutter))}</span><span class="mb-src">${highlightLine(snippet, index) || ' '}${active
      ? renderCaret(text, start, width)
      : ''}</span></span>`
  }
  const description = `Source${label
    ? ` of ${label}`
    : ''}, line ${line} highlighted`
  return `<pre class="mb-snippet"${attr('data-more-context', more)} data-lang="${escapeHtml(snippet.lang ?? '')}" aria-label="${escapeHtml(description)}" tabindex="0"><code>${rows}</code></pre>`
}

function renderCaret(text: string, column: number | undefined, width = 1): string {
  if (column === undefined || !Number.isInteger(column)) {
    return ''
  }
  const firstToken = text.search(/\S/)
  const carets = Number.isInteger(width)
    ? Math.min(Math.max(1, width), Math.max(1, text.length - column + 1))
    : 1
  return column > (firstToken < 0
    ? text.length
    : firstToken) && column <= text.length + 1
    ? `<span class="mb-caret" aria-hidden="true">${escapeHtml(text.slice(0, column - 1).replace(/[^\t]/g, ' '))}${'^'.repeat(carets)}</span>`
    : ''
}

function renderLogDrawer(): string {
  return `<section class="mb-logs" id="mb-logs" data-logs hidden aria-labelledby="mb-logs-title">
  <div class="mb-logs-head">
    <h2 id="mb-logs-title">Server logs</h2><span class="mb-live" data-live role="status"><span data-live-text>Dev server: connecting</span></span>
    <label class="mb-filter">Level <select data-log-filter><option value="">all</option><option value="warn">warn+</option><option value="error">error</option></select></label>
    <button class="mb-tool" type="button" data-action="clear-logs" title="Clear logs" aria-label="Clear logs">Clear</button>
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
  ${ICONS.warning}<button type="button" class="mb-toast-body" data-action="show-toast"><strong>${escapeHtml(report.name)}</strong><span>${inlineHtml(firstLine(report.message), report.codeSpans)}</span></button>
  <button type="button" class="mb-tool" data-action="dismiss-toast" title="Dismiss warning" aria-label="Dismiss warning">${ICONS.close}</button>
</article>`
}

import type { LogEntry } from '../../src/channel/protocol'
import type { ErrorReport, Frame } from '../../src/types'
import type { LabState, Scenario } from './data'
import { escapeHtml as esc } from '../../src/render/html/escape'
import { highlightLine } from '../../src/render/html/highlight'
import { toMarkdown } from '../../src/report/markdown'
import { nuxtLogo } from './brand'
import { command } from './data'
import { createLogPanel } from './log-panel'
import { createPagePreview } from './page-preview'
import { columnCaret } from './source-caret'
import './style.css'
import './screen.css'

type Direction = 'focus' | 'workbench' | 'trace' | 'stack'
const directions: Record<Direction, { name: string, idea: string }> = {
  focus: { name: 'Focus', idea: 'One useful frame. A clear next step. Everything else within reach.' },
  workbench: { name: 'Workbench', idea: 'Scan the issues, inspect the source, keep the context alongside.' },
  stack: { name: 'Stack', idea: 'Start at the error. Read down through its callers on one page.' },
  trace: { name: 'Trace', idea: 'Start at the root cause. Follow the failure back to the page.' },
}
const icons: Record<string, string> = {
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  external: '<path d="M14 4h6v6m0-6L9 15"/><path d="M10 4H4v16h16v-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M8 8l4-4 4 4M12 4v6M8 16l4 4 4-4M12 14v6M4 12h16"/>',
  collapse: '<path d="M8 4l4 4 4-4M12 2v6M8 20l4-4 4 4M12 16v6M4 12h16"/>',
  minus: '<path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 13h8m-8 4h5"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v3a4 4 0 0 1-4 4H6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12 0l2 5M4 12l2 5a7 7 0 0 0 12 0"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5Z"/>',
}
function icon(name: string): string {
  if (name === 'nuxt')
    return nuxtLogo
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.file}</svg>`
}
const params = new URLSearchParams(location.search)
let direction: Direction = Object.hasOwn(directions, params.get('view') ?? '') ? params.get('view') as Direction : 'focus'
let theme = params.get('theme') === 'dark' || (!params.has('theme') && direction === 'workbench') ? 'dark' : 'light'
let issue = 0
let scenarios: Scenario[] = []
let versions: Record<string, string> = {}
let sourceRoot = ''
let liveState: LabState | undefined
let connected = false
let streamEnabled = true
let archived = false
let selectedNode = ''
let appPath = ''
const runningApp = document.querySelector<HTMLIFrameElement>('#running-app')!
let minimized = false
let activeCause = true
const expandedFrameworks = new Set<string>()
const selectedFrames = new Map<string, number>()
const compiledFrames = new Set<string>()
const expandedCode = new Set<string>()
const openDetails = new Set<string>()
const traceSteps = new Map<string, string | null>()
const app = document.querySelector<HTMLDivElement>('#app')!
const dialog = document.querySelector<HTMLDialogElement>('#detail-dialog')!
let dialogTrigger: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout>
let copyMenuOpen = false
const logPanel = createLogPanel(copy)
const pagePreview = createPagePreview(() => {
  logPanel.close()
  minimized = true
  render()
  runningApp.focus()
}, () => {
  minimized = false
  render()
})

function button(action: string, label: string, symbol?: string, extra = '', className = ''): string {
  return `<button type="button" class="button ${className}" data-action="${action}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`
}
function iconButton(action: string, label: string, symbol: string, extra = ''): string {
  return button(action, '', symbol, `${extra} aria-label="${label}" title="${label}"`, 'icon-button')
}
function short(file = ''): string {
  const normalized = file.replaceAll('\\', '/').split(/[?#]/, 1)[0]!
  const dependency = normalized.lastIndexOf('/node_modules/')
  if (dependency !== -1)
    return normalized.slice(dependency + '/node_modules/'.length)
  return normalized.replace(`${sourceRoot}/`, '')
}
function loc(frame: Frame): string {
  return `${short(frame.file)}:${frame.line ?? 1}:${frame.column ?? 1}`
}
function current() {
  return scenarios[issue]!
}
function reports(): ErrorReport[] {
  const flatten = (report: ErrorReport): ErrorReport[] => [report, ...[...report.causes, ...(report.errors ?? [])].flatMap(flatten)]
  return flatten(current().report)
}
function selectedReport(): ErrorReport {
  return reports().find(report => report.id === selectedNode) ?? (direction === 'trace' && activeCause && !current().report.errors?.length ? reports().at(-1)! : current().report)
}
function findReport(id?: string) {
  return reports().find(report => report.id === id) ?? current().report
}
function originIndex(report: ErrorReport) {
  return Math.max(0, report.frames.findIndex(frame => frame.type === 'app' && frame.snippet))
}
function orderedOriginIndex(report: ErrorReport) {
  const hasCode = (frame: Frame) => !!frame.snippet || !!frame.compiled?.snippet
  const application = report.frames.findIndex(frame => frame.type === 'app' && hasCode(frame))
  return application >= 0 ? application : Math.max(0, report.frames.findIndex(hasCode))
}
function frameKey(report: ErrorReport, index: number) {
  return `${report.id}-${index}`
}

function render() {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const focusKey = focused?.closest('details')?.querySelector('summary')?.dataset.key ?? focused?.dataset.key
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.view = direction
  document.title = `${directions[direction].name} · Nuxt error screen`
  const visible = scenarios.length > 0 && !minimized
  const wasVisible = app.classList.contains('screen-visible')
  runningApp.inert = visible
  runningApp.setAttribute('aria-hidden', String(visible))
  app.classList.toggle('screen-visible', visible)
  app.innerHTML = visible
    ? `<section class="devtools" aria-label="Nuxt error screen">
    ${renderChrome()}
    ${!connected ? '<div class="connection-banner" role="status">Live updates disconnected. Displaying the last received report.</div>' : ''}
    ${archived ? '<div class="connection-banner">Previous run · These issues are no longer active.</div>' : ''}
    <div class="workspace">
      ${direction === 'workbench' ? renderIssueList() : ''}
      <main id="error-content" class="error-content" tabindex="-1">
        ${direction !== 'workbench' && scenarios.length > 1 ? renderPager() : ''}
        ${renderError(direction === 'trace' ? current().report : selectedReport())}
      </main>

    </div></section>`
    : ''
  logPanel.update(liveState?.logs ?? [], connected)
  pagePreview.update(scenarios[issue]?.report.id, scenarios[issue]?.report.message ?? '', visible)
  window.parent.postMessage({ source: 'nuxt-lab-screen', type: 'visibility', visible, hasIssues: scenarios.length > 0 }, location.origin)
  if (focusKey) {
    app.querySelectorAll<HTMLElement>('[data-key]').forEach((element) => {
      if (element.dataset.key === focusKey)
        element.focus({ preventScroll: true })
    })
  }
  else if (visible && !wasVisible) {
    document.getElementById('error-content')?.focus({ preventScroll: true })
  }
}

function renderChrome() {
  return `<header class="devtools-bar"><div class="brand">${nuxtLogo}<span class="divider"></span><span class="current-section">${scenarios.length} ${scenarios.length === 1 ? 'error' : 'errors'}</span></div><div class="chrome-tools">${iconButton('theme', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, 'sun', 'data-key="theme"')}${iconButton('context', 'View request and environment', 'info', `data-key="context" aria-haspopup="dialog" aria-controls="detail-dialog" aria-expanded="${dialog.open && dialog.dataset.triggerAction === 'context'}"`)}${iconButton('minimize', 'Minimize error screen', 'minus', 'data-key="minimize"')}</div></header>`
}

function renderPager() {
  return `<div class="issue-navigation"><div class="pager" role="group" aria-label="Navigate issues">${iconButton('previous', 'Previous issue', 'left', `${issue === 0 ? 'disabled' : ''} data-key="previous"`)}<span>${issue + 1}<span class="muted"> / ${scenarios.length}</span></span>${iconButton('next', 'Next issue', 'right', `${issue === scenarios.length - 1 ? 'disabled' : ''} data-key="next"`)}<span class="muted">${archived ? 'previous issues' : 'active issues'}</span></div><span class="route">${esc(current().route)}</span></div>`
}

function renderIssueList() {
  return `<aside class="issue-sidebar" aria-label="Issues"><div class="sidebar-heading"><strong>Issues</strong><span class="count">${scenarios.length}</span></div><p class="sidebar-caption">This render</p><div class="issue-list">${scenarios.map((scenario, index) => button('issue', `<span class="issue-dot ${scenario.category === 'Hydration' ? 'warning' : ''}"></span><span><span class="issue-item-title">${esc(scenario.report.message)}</span><span class="issue-item-meta">${esc(scenario.environment)} <span>·</span> ${esc(scenario.category)}</span></span>`, undefined, `data-index="${index}" data-key="issue-${index}" aria-current="${index === issue}"`, 'issue-item')).join('')}</div><div class="sidebar-bottom">${icon('branch')}<span>Nuxt playground<span class="muted">Local development</span></span></div></aside>`
}

function renderCausePath() {
  const root = current().report
  const aggregate = !!root.errors?.length
  const chain = aggregate ? reports() : [...reports()].reverse()
  if (chain.length < 2)
    return ''
  const selected = selectedReport().id
  if (!aggregate && chain.length === 2) {
    const cause = chain[0]!
    const inspectingCause = selected === cause.id
    const target = inspectingCause ? root : cause
    return `<nav class="single-cause" aria-label="Error cause">${inspectingCause ? '' : '<span>Caused by</span>'}${button('cause-select', esc(inspectingCause ? `Back to: ${root.message}` : cause.message), inspectingCause ? 'left' : undefined, `data-id="${target.id}" data-key="single-cause"`, 'text-button')}</nav>`
  }
  const position = chain.findIndex(report => report.id === selected)
  const last = chain.length - 1
  const role = (index: number) => aggregate ? index === 0 ? 'Reported error' : 'Related error' : index === 0 ? 'Root cause' : index === last ? 'Reported error' : 'Wrapped error'
  const entry = (index: number) => {
    const report = chain[index]!
    return button('cause-select', `<span class="cause-number">${index + 1}</span>${role(index)}`, undefined, `data-id="${report.id}" data-key="cause-${report.id}" aria-current="${selected === report.id}" title="${esc(report.message)}"`, 'trace-link')
  }
  const choices = `<ol class="trace-choices" aria-label="${aggregate ? 'Related errors' : 'Complete error chain'}">${chain.map((report, index) => `<li>${button('cause-select', `<span class="cause-number">${index + 1}</span><span class="cause-choice-text"><span>${role(index)}</span><strong>${esc(report.message)}</strong></span>${selected === report.id ? icon('check') : ''}`, undefined, `data-id="${report.id}" data-key="choice-${report.id}" aria-current="${selected === report.id}"`, 'trace-link')}</li>`).join('')}</ol>`
  const middleSelected = position > 0 && position < last
  const label = aggregate ? `${position > 0 ? `Related error ${position} of ${last}` : `${last} related errors`}` : middleSelected ? `${position + 1} Wrapped error` : `${last === 2 ? '2 Wrapped error' : `2–${last} Wrapped errors`}`
  const picker = `<details class="cause-picker" data-disclosure="causes-${root.id}" ${openDetails.has(`causes-${root.id}`) ? 'open' : ''}><summary data-key="disclosure-causes-${root.id}" ${aggregate ? position > 0 ? 'aria-current="true"' : '' : middleSelected ? 'aria-current="true"' : ''}>${label}${icon('down')}</summary>${choices}</details>`
  return `<nav class="cause-navigation" aria-label="${aggregate ? 'Related errors' : 'Error cause chain'}"><div class="compact-trace">${entry(0)}${aggregate || chain.length > 2 ? `<span class="cause-segment">${!aggregate ? icon('right') : ''}${picker}</span>` : ''}${!aggregate ? `<span class="cause-segment">${icon('right')}${entry(last)}</span>` : ''}</div><p class="cause-position">Inspecting ${role(position).toLowerCase()} · ${position + 1} of ${chain.length}${selected !== root.id ? `<span class="reported-context">Reported as: ${esc(root.message)}</span>` : ''}</p></nav>`
}

function renderError(report: ErrorReport) {
  const serverMarker = '- rendered on server:'
  const clientMarker = '- expected on client:'
  const serverIndex = report.message.indexOf(serverMarker)
  const clientIndex = report.message.indexOf(clientMarker, serverIndex)
  const hydration = report.message.startsWith('Hydration text content mismatch') && serverIndex >= 0 && clientIndex > serverIndex
    ? [report.message.slice(serverIndex + serverMarker.length, clientIndex).trim(), report.message.slice(clientIndex + clientMarker.length).trim()]
    : undefined
  const title = hydration ? 'Server and client rendered different text' : report.message
  return `<article class="error-report" aria-labelledby="error-title">
    <div class="error-heading"><div class="taxonomy"><span class="error-class">${esc(report.name)}</span><span class="meta-separator">·</span><span>${esc(current().environment)}</span></div><div class="error-tools">${button('copy', 'Copy error', 'copy', `data-id="${report.id}" data-key="copy-error"`, 'copy-button')}${iconButton('export', 'More copy formats', 'down', `data-id="${report.id}" data-key="export" aria-haspopup="menu" aria-controls="copy-formats" aria-expanded="${copyMenuOpen}"`)}<div id="copy-formats" class="copy-menu" role="menu" aria-label="Copy format" ${copyMenuOpen ? '' : 'hidden'}>${button('export-markdown', 'Copy as Markdown', 'copy', 'role="menuitem" tabindex="-1" data-key="copy-markdown"')}${button('export-prompt', 'Copy prompt for an agent', 'terminal', 'role="menuitem" tabindex="-1" data-key="copy-prompt"')}${button('export-json', 'Copy structured JSON', 'file', 'role="menuitem" tabindex="-1" data-key="copy-json"')}</div></div></div>
    <h1 id="error-title">${esc(title.length > 300 ? `${title.slice(0, 300)}…` : title)}</h1>${report.message.length > 300 || hydration ? `<details class="full-message"><summary>Show original message (${report.message.length} characters)</summary><pre tabindex="0">${esc(report.message)}</pre></details>` : ''}
    ${report.hint ? `<p class="explanation">${esc(report.hint)}</p>` : ''}
    ${direction === 'trace' ? '' : renderCausePath()}
    ${hydration ? `<section class="diff-card" aria-label="Hydration difference"><div class="diff-heading"><strong>What changed</strong><span>Reported by Vue</span></div><div class="diff-code"><code class="diff-remove">− Server: ${esc(hydration[0])}</code><code class="diff-add">+ Client: ${esc(hydration[1])}</code></div></section>` : ''}
    ${direction === 'trace' ? renderTraceSequence() : direction === 'stack' ? renderOrderedStack(report) : `${renderSource(report)}${renderDiagnostics(report)}`}
    ${current().report.docsUrl ? `<a class="docs-link" href="${esc(current().report.docsUrl)}" target="_blank" rel="noreferrer">${icon('book')} Read the Nuxt hydration guide ${icon('external')}</a>` : ''}
  </article>`
}

function renderTrail() {
  const trace = current().report.trace
  if (!trace?.length)
    return current().category === 'Build' ? '<div class="build-context">Vite · Template compilation</div>' : ''
  return `<nav class="component-trail" aria-label="Component trace">${trace.map((entry, index) => `${index ? icon('right') : ''}${entry.file ? button('component', `&lt;${esc(entry.label.replace(/^<|>$/g, ''))}&gt;`, undefined, `data-index="${index}" data-key="component-${index}"`, index === trace.length - 1 ? 'responsible text-button' : 'text-button') : `<span>&lt;${esc(entry.label.replace(/^<|>$/g, ''))}&gt;</span>`}`).join('')}<span class="responsible-caption">${direction === 'trace' ? 'component trace' : 'component'}</span></nav>`
}

function renderSource(report: ErrorReport, index = originIndex(report), preview = false, ordered = false) {
  if (!ordered && report.kind === 'warning' && !report.frames.some(frame => frame.type === 'app'))
    return '<p class="explanation">Vue did not provide an exact source line for this warning. Expand Component trace below to inspect the source.</p>'
  const frame = report.frames[index]
  if (!frame)
    return '<p class="explanation">No stack trace was provided. The error message and request context are still available to copy.</p>'
  const key = frameKey(report, index)
  const attrs = `data-id="${report.id}" data-index="${index}"`
  const compiled = (compiledFrames.has(key) || (ordered && !frame.snippet)) && frame.compiled
  const location = compiled || frame
  const snippet = location.snippet
  const editable = !!frame.snippet && frame.file?.startsWith(`${sourceRoot}/`)
  const contextRange = snippet ? [Math.max(snippet.start, (location.line ?? snippet.start) - 3), (location.line ?? snippet.start) + 3] : undefined
  const hasMoreContext = !!snippet && !!contextRange && (snippet.start < contextRange[0]! || snippet.start + snippet.lines.length - 1 > contextRange[1]!)
  const codeRange = expandedCode.has(key) ? undefined : contextRange
  const fileLabel = `<span>${esc(short(location.file))}</span><span class="muted">:${location.line ?? 1}:${location.column ?? 1}</span>`
  const hasCode = !!frame.snippet || !!frame.compiled?.snippet
  const sourceSwitch = ordered ? !!frame.snippet && !!frame.compiled?.snippet : !!frame.compiled
  const locationMarkup = editable ? button('location', fileLabel, undefined, `${attrs} data-key="location-${key}" title="Edit original source"`, 'text-button') : `<span class="unavailable-location">${fileLabel}</span>`
  const orderedHeader = `<div class="ordered-frame-info"><div class="ordered-function" title="${esc(frame.function ?? '<anonymous>')}">${esc(frame.function ?? '<anonymous>')}</div>${location.file ? `<div class="source-location">${locationMarkup}</div>` : ''}</div>`
  if (ordered && !hasCode)
    return `<section class="ordered-empty" data-stack-index="${index + 1}" aria-label="Stack frame ${index + 1}">${orderedHeader}</section>`
  return `<section class="source-card ${preview ? 'frame-preview' : 'error-source'}" aria-label="${ordered ? `Stack frame ${index + 1}` : preview ? 'Frame preview' : 'Error source'}" data-origin="${index === (ordered ? orderedOriginIndex(report) : originIndex(report))}" ${ordered ? `data-stack-index="${index + 1}"` : ''} ${preview ? `id="preview-${key}"` : ''}>
    <div class="source-toolbar">${ordered ? orderedHeader : `<div class="source-location">${locationMarkup}</div>`}<div class="source-actions">${sourceSwitch ? `<div class="source-switch" role="group" aria-label="Code view">${button('source', 'Source', undefined, `${attrs} data-key="source-${key}" aria-pressed="${!compiled}"`)}${button('compiled', 'Compiled', undefined, `${attrs} data-key="compiled-${key}" aria-pressed="${!!compiled}"`)}</div>` : ''}${hasMoreContext ? iconButton('code-context', expandedCode.has(key) ? 'Less context' : 'More context', expandedCode.has(key) ? 'collapse' : 'expand', `${attrs} data-key="code-context-${key}" aria-expanded="${expandedCode.has(key)}"`) : ''}${editable ? iconButton('editor', 'Open original source in your editor', 'external', `${attrs} data-key="open-${key}"`) : ''}${preview ? iconButton('frame-close', 'Close frame preview', 'close', `${attrs} data-key="close-${key}"`) : ''}</div></div>
    ${compiled ? '<p class="compiled-note">Compiled JavaScript · Editor opens the original source location.</p>' : ''}
    ${snippet
      ? `<pre tabindex="0" style="--line-number-width: ${Math.max(2, String(snippet.start + snippet.lines.length - 1).length)}ch" aria-label="${compiled ? 'Compiled' : 'Source'} code, line ${location.line} highlighted"><code>${snippet.lines.map((line, lineIndex) => {
        const number = snippet.start + lineIndex
        if (codeRange && (number < codeRange[0]! || number > codeRange[1]!))
          return ''
        const active = number === location.line
        const caret = active ? columnCaret(line, location.column) : undefined
        return `<span class="code-line ${active ? 'active-line' : ''}" ${active ? 'aria-current="true"' : ''}><span class="line-number" aria-hidden="true">${number}</span><span class="line-text">${highlightLine(snippet, lineIndex) || ' '}${caret === undefined ? '' : `<span class="column-caret" aria-hidden="true">${esc(caret)}</span>`}</span></span>`
      }).join('')}</code></pre>`
      : '<p class="unavailable">Source is unavailable at this stack location. It may refer to generated code without a source mapping.</p>'}
  </section>`
}

function renderOrderedStack(report: ErrorReport) {
  if (!report.frames.length || (report.kind === 'warning' && !report.frames.some(frame => frame.type === 'app')))
    return `${renderSource(report)}${renderSupportingDetails()}`
  const id = `stack-${report.id}`
  const origin = orderedOriginIndex(report)
  const expanded = openDetails.has(id)
  const showFramework = expandedFrameworks.has(report.id)
  const frameworkCount = report.frames.filter(frame => frame.type !== 'app').length
  const group = (indices: number[]) => {
    const first = indices[0]! + 1
    const last = indices.at(-1)! + 1
    const missing = indices.every(index => !report.frames[index]!.snippet && !report.frames[index]!.compiled?.snippet)
    return `<div class="ordered-framework"><div class="ordered-group-caption"><span class="ordered-range">${first === last ? first : `${first} – ${last}`}</span><span>${indices.length} framework frame${indices.length === 1 ? '' : 's'}${showFramework ? '' : ' hidden'}</span>${showFramework && missing ? '<span class="ordered-missing">Code not captured</span>' : ''}</div>${showFramework ? indices.map(index => renderSource(report, index, false, true)).join('') : ''}</div>`
  }
  let content = ''
  let indices: number[] = []
  if (expanded) {
    report.frames.forEach((frame, index) => {
      if (index === origin && origin === 0)
        return
      if (frame.type !== 'app' && index !== origin) {
        indices.push(index)
        return
      }
      if (indices.length) {
        content += group(indices)
        indices = []
      }
      content += index === origin
        ? `<div class="ordered-group-caption" data-stack-reference="${index + 1}"><span class="ordered-function">${esc(frame.function ?? '<anonymous>')}</span><span>Shown above</span></div>`
        : renderSource(report, index, false, true)
    })
    if (indices.length)
      content += group(indices)
  }
  return `<div class="ordered-stack">${renderSource(report, origin, false, true)}<section class="stack-disclosure"><div class="stack-heading">${button('stack-toggle', `Call stack <span class="stack-count">${report.frames.length}</span>`, expanded ? 'down' : 'right', `data-id="${report.id}" data-key="${id}" aria-expanded="${expanded}" aria-controls="${id}"`, 'text-button stack-toggle')}${frameworkCount ? `<button type="button" role="switch" class="framework-switch" data-action="framework" data-id="${report.id}" data-key="framework-${report.id}" aria-checked="${showFramework}" aria-label="Show framework frames"><span class="switch-track" aria-hidden="true"></span><span>Show framework frames <span class="stack-count">(${frameworkCount})</span></span></button>` : ''}</div><div id="${id}" ${expanded ? '' : 'hidden'}>${content}</div></section></div><div class="trace-details">${renderSupportingDetails()}</div>`
}

function defaultTraceStep() {
  const chain = current().report.errors?.length ? reports() : [...reports()].reverse()
  return chain.find(report => report.frames.some(frame => frame.snippet)) ?? chain[0]!
}

function renderTraceSequence() {
  const root = current().report
  const aggregate = !!root.errors?.length
  const chain = aggregate ? reports() : [...reports()].reverse()
  if (chain.length === 1)
    return `<div class="execution-trace">${root.frames.length ? renderStackDisclosure(root, true) : renderSource(root)}${renderSupportingDetails()}</div>`
  const active = traceSteps.has(root.id) ? traceSteps.get(root.id) : defaultTraceStep().id
  return `<section class="causal-sequence" aria-label="${aggregate ? 'Related errors' : 'Error propagation'}"><div class="sequence-heading">${aggregate ? 'Related errors' : 'Error propagation'} <span>${aggregate ? chain.length - 1 : chain.length}</span></div><ol class="sequence-list">${chain.map((report, index) => {
    const selected = report.id === active
    const label = aggregate ? index === 0 ? 'Aggregate' : 'Related error' : index === 0 ? 'Root cause' : index === chain.length - 1 ? 'Reported error' : 'Wrapped by'
    const frame = report.frames[originIndex(report)]
    return `<li class="sequence-step" data-expanded="${selected}">${button('trace-step', `<span class="step-disclosure">${icon(selected ? 'down' : 'right')}</span><span class="step-content"><span class="step-label">${label} <span>· ${esc(report.name)}</span></span><strong>${esc(report.message)}</strong></span>${frame ? `<code class="step-location">${esc(loc(frame))}</code>` : ''}`, undefined, `data-id="${report.id}" data-key="trace-step-${report.id}" aria-expanded="${selected}" aria-controls="step-${report.id}"`, 'step-button')}<div id="step-${report.id}" class="step-body" ${selected ? '' : 'hidden'}>${selected ? `${renderSource(report)}${renderStackDisclosure(report)}` : ''}</div></li>`
  }).join('')}</ol></section>${renderSupportingDetails()}`
}

function renderSupportingDetails() {
  const trace = current().report.trace
  const id = `components-${current().report.id}`
  const expanded = openDetails.has(id)
  const components = trace?.length ? `<section class="component-disclosure"><div class="stack-heading">${button('components-toggle', `Component trace <span class="stack-count">${trace.length}</span>`, expanded ? 'down' : 'right', `data-key="${id}" aria-expanded="${expanded}" aria-controls="${id}"`, 'text-button stack-toggle')}</div><div id="${id}" class="component-body" ${expanded ? '' : 'hidden'}>${renderTrail()}</div></section>` : ''
  return `${components}<div class="secondary-actions">${button('context', 'Request & environment', 'info', `data-key="context-footer" aria-haspopup="dialog" aria-controls="detail-dialog" aria-expanded="${dialog.open && dialog.dataset.triggerAction === 'context'}"`, 'text-button')}${button('logs', 'Logs', 'terminal', `data-key="logs" aria-expanded="${logPanel.isOpen}" aria-controls="server-logs"`, 'text-button')}${button('history', 'History', 'branch', `data-key="history" aria-pressed="${archived}" title="${archived ? 'Showing previous issues — return to active issues' : 'Show previous issues'}"`, 'text-button')}</div>`
}

function renderStackDisclosure(report: ErrorReport, inlineOrigin = false) {
  if (!report.frames.length)
    return ''
  const hiddenCount = report.frames.filter(frame => frame.type !== 'app').length
  const id = `stack-${report.id}`
  const expanded = openDetails.has(id) || (inlineOrigin && !openDetails.has(`closed-${id}`))
  return `<section class="stack-disclosure"><div class="stack-heading">${button('stack-toggle', `Call stack <span class="stack-count">${report.frames.length}</span>`, expanded ? 'down' : 'right', `data-id="${report.id}" data-key="stack-${report.id}" aria-expanded="${expanded}" aria-controls="${id}"`, 'text-button stack-toggle')}${hiddenCount ? `<button type="button" role="switch" class="framework-switch" data-action="framework" data-id="${report.id}" data-key="framework-${report.id}" aria-checked="${expandedFrameworks.has(report.id)}" aria-label="Show framework frames"><span class="switch-track" aria-hidden="true"></span><span>Show framework frames <span class="stack-count">(${hiddenCount})</span></span></button>` : ''}</div><div id="${id}" ${expanded ? '' : 'hidden'}>${renderStack(report, inlineOrigin)}</div></section>`
}

function renderDiagnostics(report: ErrorReport) {
  return `<div class="trace-details">${renderStackDisclosure(report)}${renderSupportingDetails()}</div>`
}

function renderStack(report: ErrorReport, inlineOrigin = false) {
  const expanded = expandedFrameworks.has(report.id)
  const origin = originIndex(report)
  return `<section class="stack" aria-label="Call stack"><ol class="stack-list">${report.frames.map((frame, index) => {
    const selected = (selectedFrames.get(report.id) ?? (inlineOrigin ? origin : -1)) === index
    const key = frameKey(report, index)
    const staticOrigin = index === origin && !inlineOrigin
    const content = `<span class="frame-name">${icon(staticOrigin ? 'file' : selected ? 'down' : 'right')}<span class="frame-function" title="${esc(frame.function ?? '<anonymous>')}">${esc(frame.function ?? '<anonymous>')}</span>${index === origin ? `<span class="frame-label">${staticOrigin ? 'Shown above' : 'Error location'}</span>` : ''}</span><span class="frame-location" title="${esc(frame.file)}:${frame.line ?? 1}:${frame.column ?? 1}"><span class="frame-path">${esc(short(frame.file))}</span><span class="frame-coordinates">:${frame.line ?? 1}:${frame.column ?? 1}</span></span>`
    return `<li data-expanded="${selected}" ${frame.type !== 'app' && !expanded ? 'hidden' : ''}>${staticOrigin ? `<div class="stack-frame origin-frame">${content}</div>` : button('frame', content, undefined, `data-id="${report.id}" data-index="${index}" data-key="frame-${key}" aria-expanded="${selected}" ${selected ? `aria-controls="preview-${key}"` : ''}`, `stack-frame ${frame.type !== 'app' ? 'framework-frame' : ''}`)}${selected && !staticOrigin ? renderSource(report, index, true) : ''}</li>`
  }).join('')}</ol></section>`
}

function notify(message: string) {
  const notice = document.querySelector<HTMLDivElement>('#notice')!
  clearTimeout(toastTimer)
  notice.textContent = message
  notice.classList.add('visible')
  toastTimer = setTimeout(() => notice.classList.remove('visible'), 3500)
}
function openDialog(title: string, body: string) {
  dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2>${iconButton('dialog-close', 'Close dialog', 'close')}</div>${body}`
  dialog.dataset.triggerAction = dialogTrigger?.dataset.action ?? ''
  dialog.showModal()
  app.querySelectorAll('[aria-controls="detail-dialog"]').forEach(button => button.setAttribute('aria-expanded', String((button as HTMLElement).dataset.action === dialog.dataset.triggerAction)))
}
function markdown(report = current().report): string {
  const scenario = current()
  return `${toMarkdown(report, { cwd: sourceRoot })}\n## Reproduction context\n\nEnvironment: ${esc(scenario.environment)}\nRoute: ${scenario.route}\nVersions: ${Object.entries(versions).map(([name, version]) => `${name} ${version}`).join(', ')}\n`
}
async function copy(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify(message)
  }
  catch {
    if (dialog.open)
      dialog.close()
    openDialog('Copy error', `<p class="explanation">Clipboard access is unavailable. Select and copy the report below.</p><textarea class="copy-fallback" aria-label="Error report" readonly>${esc(text)}</textarea>`)
    dialog.querySelector('textarea')?.select()
  }
}
function setIssue(index: number) {
  issue = Math.min(scenarios.length - 1, Math.max(0, index))
  selectedNode = ''
  activeCause = true
  minimized = false
  render()
}

function setCopyMenu(open: boolean, restoreFocus = false) {
  copyMenuOpen = open
  const trigger = app.querySelector<HTMLElement>('[data-action="export"]')
  const menu = app.querySelector<HTMLElement>('.copy-menu')
  trigger?.setAttribute('aria-expanded', String(open))
  if (menu)
    menu.hidden = !open
  if (restoreFocus)
    trigger?.focus()
}

document.addEventListener('focusin', (event) => {
  if (copyMenuOpen && !(event.target as Element).closest('.error-tools'))
    setCopyMenu(false)
})

document.addEventListener('click', async (event) => {
  if (copyMenuOpen && !(event.target as Element).closest('.error-tools'))
    setCopyMenu(false)
  app.querySelectorAll<HTMLDetailsElement>('.cause-picker[open]').forEach((menu) => {
    if (!menu.contains(event.target as Node)) {
      openDetails.delete(menu.dataset.disclosure!)
      menu.open = false
    }
  })
  const target = (event.target as Element).closest<HTMLElement>('[data-action]')
  if (!target)
    return
  const action = target.dataset.action
  const report = scenarios.length ? findReport(target.dataset.id) : undefined!
  if (action === 'direction') {
    direction = target.dataset.view as Direction
    theme = direction === 'workbench' ? 'dark' : 'light'
    activeCause = true
    minimized = false
    render()
  }
  else if (action === 'theme') {
    theme = theme === 'light' ? 'dark' : 'light'
    render()
    window.parent.postMessage({ source: 'nuxt-lab-screen', type: 'theme', theme }, location.origin)
  }
  else if (action === 'code-context') {
    if (expandedCode.has(frameKey(report, Number(target.dataset.index))))
      expandedCode.delete(frameKey(report, Number(target.dataset.index)))
    else expandedCode.add(frameKey(report, Number(target.dataset.index)))
    render()
  }
  else if (action === 'issue') {
    setIssue(Number(target.dataset.index))
  }
  else if (action === 'previous' || action === 'next') {
    setIssue(issue + (action === 'next' ? 1 : -1))
  }
  else if (action === 'framework') {
    if (expandedFrameworks.has(report.id))
      expandedFrameworks.delete(report.id)
    else expandedFrameworks.add(report.id)
    render()
  }
  else if (action === 'components-toggle') {
    const id = `components-${current().report.id}`
    if (openDetails.has(id))
      openDetails.delete(id)
    else openDetails.add(id)
    render()
  }
  else if (action === 'stack-toggle') {
    const id = `stack-${report.id}`
    if (openDetails.has(id) || (direction === 'trace' && reports().length === 1 && !openDetails.has(`closed-${id}`))) {
      openDetails.delete(id)
      openDetails.add(`closed-${id}`)
    }
    else {
      openDetails.add(id)
      openDetails.delete(`closed-${id}`)
    }
    render()
  }
  else if (action === 'trace-step') {
    const root = current().report
    const first = defaultTraceStep()
    const active = traceSteps.has(root.id) ? traceSteps.get(root.id) : first.id
    traceSteps.set(root.id, active === report.id ? null : report.id)
    render()
    app.querySelector<HTMLElement>(`[data-key="trace-step-${report.id}"]`)?.focus()
  }
  else if (action === 'frame' || action === 'frame-close') {
    const index = Number(target.dataset.index)
    if (action === 'frame-close' || (selectedFrames.get(report.id) ?? (direction === 'trace' && reports().length === 1 ? originIndex(report) : -1)) === index)
      selectedFrames.set(report.id, -1)
    else selectedFrames.set(report.id, index)
    render()
    app.querySelector<HTMLElement>(`[data-key="frame-${frameKey(report, index)}"]`)?.focus()
  }
  else if (action === 'source' || action === 'compiled') {
    const key = frameKey(report, Number(target.dataset.index))
    if (action === 'source')
      compiledFrames.delete(key)
    else compiledFrames.add(key)
    render()
  }
  else if (action === 'cause-select') {
    openDetails.delete(`causes-${current().report.id}`)
    selectedNode = report.id
    activeCause = report.id !== current().report.id
    render()
    const navigation = app.querySelector<HTMLElement>('.compact-trace > .trace-link[aria-current="true"], .cause-segment > .trace-link[aria-current="true"], .cause-picker > summary[aria-current="true"]')
    navigation?.focus({ preventScroll: true })
  }
  else if (action === 'copy') {
    setCopyMenu(false)
    await copy(markdown(), 'Error copied as Markdown, including causes and context')
  }
  else if (action === 'export') {
    setCopyMenu(!copyMenuOpen)
    if (copyMenuOpen)
      app.querySelector<HTMLElement>('.copy-menu [role="menuitem"]')?.focus()
  }
  else if (action?.startsWith('export-')) {
    setCopyMenu(false, true)
    await copy(action === 'export-json' ? JSON.stringify({ ...current(), versions }, null, 2) : `${action === 'export-prompt' ? 'Help diagnose this Nuxt error. Trace the root cause in the source, explain the failure, and propose the smallest appropriate fix. Verify the fix against the relevant behavior.\n\n' : ''}${markdown()}`, action === 'export-json' ? 'Structured report copied' : action === 'export-prompt' ? 'Prompt copied with the full error context' : 'Markdown copied')
  }
  else if (action === 'location' || action === 'component' || action === 'editor') {
    const entry = action === 'component' ? current().report.trace![Number(target.dataset.index)]! : report.frames[Number(target.dataset.index)]!
    if (!entry.file) {
      notify('No file location is available')
      return
    }
    if (action === 'editor') {
      try {
        await command('open', { file: entry.file, line: entry.line, column: entry.column })
        notify('Opened in your editor')
      }
      catch {
        notify('Could not launch an editor. Click the file name to use the playground editor.')
      }
    }
    else {
      window.parent.postMessage({ source: 'nuxt-lab-screen', type: 'edit', file: entry.file }, location.origin)
    }
  }
  else if (action === 'context') {
    openDialog('Request & environment', `<div class="dialog-sections">${current().report.sections.map(section => `<section><h3>${esc(section.title)}</h3><dl>${Object.entries(section.content).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl></section>`).join('')}</div>`)
  }
  else if (action === 'logs') {
    logPanel.toggle()
  }
  else if (action === 'shortcuts') {
    openDialog('Keyboard shortcuts', '<dl class="shortcut-list"><dt>Previous / next issue</dt><dd><kbd>←</kbd> <kbd>→</kbd></dd><dt>Minimize / restore screen</dt><dd><kbd>esc</kbd></dd><dt>Move between controls</dt><dd><kbd>tab</kbd></dd></dl><p class="explanation">Arrow shortcuts pause while a form field or source code has focus.</p>')
  }
  else if (action === 'dialog-close') {
    dialog.close()
  }
  else if (action === 'minimize' || action === 'restore') {
    if (logPanel.isOpen) {
      logPanel.close()
      return
    }
    if (!scenarios.length) {
      notify(streamEnabled ? 'The Nuxt app has no active issues' : 'Reconnect the stream to receive current issues')
      return
    }
    minimized = !minimized
    render()
    if (minimized)
      runningApp.focus()
    else document.getElementById('error-content')?.focus()
  }
  else if (action === 'reload') {
    runningApp.src = appPath
  }
  else if (action === 'history') {
    if (!liveState?.archived.length) {
      notify('No previous issues yet')
      return
    }
    archived = !archived
    scenarios = archived ? liveState.archived : liveState.reports
    issue = 0
    minimized = false
    render()
  }
})
document.addEventListener('toggle', (event) => {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement) || !target.isConnected || !target.dataset.disclosure)
    return
  if (target.open)
    openDetails.add(target.dataset.disclosure)
  else openDetails.delete(target.dataset.disclosure)
}, true)
document.addEventListener('keydown', (event) => {
  const copyTrigger = (event.target as Element).closest('[data-action="export"]')
  if (!dialog.open && (copyMenuOpen || (copyTrigger && ['ArrowDown', 'ArrowUp'].includes(event.key)))) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape')
        event.preventDefault()
      setCopyMenu(false, true)
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setCopyMenu(true)
      const items = [...app.querySelectorAll<HTMLElement>('.copy-menu [role="menuitem"]')]
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length)
      items[next]?.focus()
    }
    return
  }
  if (dialog.open || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.target as Element).closest('select, input, textarea, pre, [contenteditable="true"]'))
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    const menu = app.querySelector<HTMLDetailsElement>('.cause-picker[open]')
    if (menu) {
      openDetails.delete(menu.dataset.disclosure!)
      menu.open = false
      menu.querySelector('summary')?.focus()
      return
    }
    if (logPanel.isOpen) {
      logPanel.close()
      return
    }
    if (!scenarios.length) {
      notify(streamEnabled ? 'The Nuxt app has no active issues' : 'Reconnect the stream to receive current issues')
      return
    }
    minimized = !minimized
    render()
    if (minimized)
      runningApp.focus()
    else document.getElementById('error-content')?.focus()
  }
  else if (scenarios.length && !minimized && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault()
    setIssue(issue + (event.key === 'ArrowRight' ? 1 : -1))
    document.getElementById('error-content')?.focus()
    notify(`Issue ${issue + 1} of ${scenarios.length}: ${current().report.message}`)
  }
})
dialog.addEventListener('close', () => {
  app.querySelectorAll('[aria-controls="detail-dialog"]').forEach(button => button.setAttribute('aria-expanded', 'false'))
  if (dialogTrigger?.isConnected)
    dialogTrigger.focus()
})
dialog.addEventListener('click', (event) => {
  if (event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.clientWidth || event.offsetY > dialog.clientHeight))
    dialog.close()
})

let source: EventSource | undefined
let refreshPending = false
let refreshQueued = false
async function refresh() {
  if (!streamEnabled)
    return
  if (refreshPending) {
    refreshQueued = true
    return
  }
  refreshPending = true
  try {
    const response = await fetch('/__lab/state')
    if (!response.ok)
      throw new Error('Server unavailable')
    const next: LabState = await response.json()
    const selectedId = scenarios[issue]?.report.id
    const previousRun = liveState?.run
    liveState = next
    sourceRoot = next.cwd
    versions = next.versions
    if (previousRun !== next.run) {
      archived = false
      selectedNode = ''
      minimized = false
    }
    scenarios = archived ? next.archived : next.reports
    issue = Math.max(0, scenarios.findIndex(item => item.report.id === selectedId))
    if (next.ready && appPath !== next.path) {
      appPath = next.path
      runningApp.src = appPath
    }
    render()
  }
  catch {
    connected = false
    render()
  }
  finally {
    refreshPending = false
    if (refreshQueued) {
      refreshQueued = false
      void refresh()
    }
  }
}
function connect() {
  source?.close()
  source = new EventSource('/__lab/events')
  source.onopen = () => {
    connected = true
    void refresh()
  }
  source.onerror = () => {
    connected = false
    render()
  }
  source.addEventListener('log', (event) => {
    const entry: LogEntry = JSON.parse(event.data)
    if (liveState) {
      liveState.logs = [...liveState.logs.slice(-199), entry]
      logPanel.update(liveState.logs, connected)
    }
  })
  for (const type of ['hello', 'error:set', 'error:clear', 'warning', 'build']) source.addEventListener(type, () => void refresh())
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin)
    return
  if (event.source === runningApp.contentWindow && event.data?.source === 'nuxt-lab-app') {
    if (event.data.type === 'mounted')
      void command('mounted', { run: event.data.run, fixed: event.data.fixed })
    return
  }
  if (event.source !== window.parent || event.data?.source !== 'nuxt-lab-shell')
    return
  if (event.data.type === 'toggle-error' && scenarios.length) {
    minimized = !minimized
    render()
  }
  else if (event.data.type === 'history' && liveState?.archived.length) {
    archived = true
    scenarios = liveState.archived
    issue = 0
    minimized = false
    render()
  }
  else if (event.data.type === 'design') {
    if (Object.hasOwn(directions, event.data.view))
      direction = event.data.view
    theme = event.data.theme === 'dark' ? 'dark' : 'light'
    render()
  }
  else if (event.data.type === 'app' && event.data.ready && typeof event.data.path === 'string' && event.data.path.startsWith('/app/')) {
    if (appPath !== event.data.path) {
      appPath = event.data.path
      runningApp.src = appPath
    }
  }
  else if (event.data.type === 'presentation') {
    document.documentElement.dataset.presentation = event.data.value === 'overlay' ? 'overlay' : 'page'
  }
  else if (event.data.type === 'reload') {
    runningApp.src = appPath
  }
  else if (event.data.type === 'refresh') {
    void refresh()
  }
  else if (event.data.type === 'connection') {
    streamEnabled = !!event.data.connected
    if (streamEnabled) {
      connect()
    }
    else {
      source?.close()
      connected = false
      render()
    }
  }
})
connect()
void refresh()
window.parent.postMessage({ source: 'nuxt-lab-screen', type: 'ready' }, location.origin)

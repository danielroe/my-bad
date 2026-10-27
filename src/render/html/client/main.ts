import type { ChannelEvent } from '../../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../../types'
import type { Dock, PageState } from '../state'
import { toMarkdown } from '../../../report/markdown'
import { escapeHtml } from '../escape'
import { THEME_STORAGE_KEY } from '../state'
import { ICONS, pagerIndex, renderPager, renderToast, renderView, reportEntries, warningCount, warningLabel } from '../view'

declare global {
  interface Window { __MY_BAD__?: PageState }
}

const STORAGE = {
  theme: THEME_STORAGE_KEY,
  dock: 'my-bad:overlay:dock',
  minimized: 'my-bad:overlay:minimized',
}

const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'

let connected = false
const actions = new Set<string>()

interface Mount {
  state: PageState
  /** The error to return to when a warning shown in its place is retired. */
  error?: ErrorReport
  selected?: string
  /** Element that receives `data-theme`. */
  themeTarget: Element
  /** Element containing the rendered view. */
  root: HTMLElement
  /** Overlay wrapper, only in overlay mode. */
  overlay?: HTMLElement
  restore?: HTMLElement
  /** Thumbnail of the page behind the overlay, shown while maximised. */
  preview?: HTMLElement
}

function readState(): PageState | undefined {
  const script = document.currentScript as HTMLScriptElement | null
  const holder = script?.previousElementSibling
  if (holder instanceof HTMLScriptElement && holder.type === 'application/json') {
    try {
      return JSON.parse(holder.textContent || '')
    }
    catch {}
  }
  return window.__MY_BAD__
}

function storage(key: string, value?: string | null): string | null {
  return store(() => localStorage, key, value)
}

/** Dismissal is remembered per project, so another project on this origin still shows its errors. */
function hiddenKey(cwd?: string): string {
  return `my-bad:overlay:hidden${cwd ? `:${cwd}` : ''}`
}

function session(key: string, value?: string | null): string | null {
  return store(() => sessionStorage, key, value)
}

/** The area is read lazily: touching it throws outright on an opaque origin. */
function store(getArea: () => Storage, key: string, value?: string | null): string | null {
  try {
    const area = getArea()
    if (value === undefined) {
      return area.getItem(key)
    }
    if (value === null) {
      area.removeItem(key)
    }
    else {
      area.setItem(key, value)
    }
  }
  catch {}
  return null
}

function pipButton(action: string, className: string, label: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `mb-pip-button ${className}`
  button.title = label
  button.setAttribute('aria-label', label)
  button.dataset.action = action
  button.innerHTML = icon
  return button
}

function mount(): Mount | undefined {
  const state = readState()
  if (!state) {
    return
  }
  if (state.mode === 'overlay') {
    const host = (document.currentScript?.previousElementSibling?.previousElementSibling as HTMLElement | null) ?? document.querySelector<HTMLElement>(state.tag ?? 'my-bad-overlay')
    return host ? overlayMount(state, host) : undefined
  }
  const root = document.querySelector<HTMLElement>('[data-my-bad-root]')
  if (!root) {
    return
  }
  return { state, error: errorOf(state.report), themeTarget: document.documentElement, root }
}

function errorOf(report: ErrorReport | undefined): ErrorReport | undefined {
  return report?.kind === 'warning' ? undefined : report
}

function overlayMount(state: PageState, host: HTMLElement): Mount {
  const shadow = host.attachShadow({ mode: 'open' })
  const sheets: HTMLElement[] = []
  if (state.stylesUrl) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = state.stylesUrl
    sheets.push(link)
  }
  const style = document.createElement('style')
  style.textContent = state.styles ?? ''
  sheets.push(style)
  const overlay = document.createElement('div')
  overlay.className = 'mb-overlay'
  overlay.dataset.overlay = ''
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Error details')
  overlay.setAttribute('lang', 'en')
  const root = document.createElement('div')
  root.className = 'mb-root'
  root.dataset.myBadRoot = ''
  root.innerHTML = renderView(state)
  const close = pipButton('hide', 'mb-overlay-close', 'Hide error overlay', ICONS.close)
  const expand = pipButton('expand', 'mb-overlay-expand', 'Show error details', EXPAND_ICON)
  const restore = document.createElement('button')
  restore.type = 'button'
  restore.className = 'mb-restore'
  restore.dataset.action = 'restore'
  restore.hidden = true
  restore.textContent = 'Show error overlay'
  const preview = document.createElement('div')
  preview.className = 'mb-preview'
  preview.dataset.preview = ''
  preview.hidden = true
  preview.innerHTML = `<button type="button" class="mb-preview-toggle" data-action="minimize" title="Show page behind this error" aria-label="Show page behind this error"><iframe class="mb-preview-frame" title="" aria-hidden="true" tabindex="-1" sandbox="" inert></iframe><span class="mb-preview-label">Show page</span></button><button type="button" class="mb-pip-button mb-preview-close" data-action="hide-preview" title="Hide page preview" aria-label="Hide page preview">${ICONS.close}</button>`
  overlay.append(expand, close, root, preview)
  shadow.append(...sheets, overlay, restore)
  return { state, error: errorOf(state.report), themeTarget: host, root, overlay, restore, preview }
}

function applyTheme(m: Mount): void {
  const forced = m.state.theme?.scheme
  const remembered = storage(STORAGE.theme)
  const stored = remembered === 'light' || remembered === 'dark' ? remembered : undefined
  const scheme = forced ?? stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  m.themeTarget.setAttribute('data-theme', scheme)
}

function toggleTheme(m: Mount): void {
  const next = m.themeTarget.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  m.themeTarget.setAttribute('data-theme', next)
  storage(STORAGE.theme, next)
}

function announce(m: Mount, text: string): void {
  const region = m.root.querySelector<HTMLElement>('[data-announce]')
  if (region) {
    region.textContent = ''
    setTimeout(() => (region.textContent = text), 50)
  }
}

/** Focus the `<main>` landmark rather than the heading, so no focus ring appears around the title. */
function focusHeading(m: Mount): void {
  m.root.querySelector<HTMLElement>('main')?.focus({ preventScroll: true })
}

function setLive(m: Mount, value: boolean): void {
  connected = value
  const el = m.root.querySelector('[data-live]')
  el?.toggleAttribute('data-connected', value)
  const text = el?.querySelector('[data-live-text]')
  if (text) {
    text.textContent = `Dev server: ${value ? 'connected' : 'disconnected'}`
  }
}

function childNodesOf(el: Element | null): ChildNode[] {
  return el ? [...el.childNodes] : []
}

/** Pending removal of a dismissed overlay's host. */
let dismissal: ReturnType<typeof setTimeout> | undefined

/** Cancel a pending dismissal, and build a new host if it has already gone. */
function revive(m: Mount): void {
  if (m.state.mode !== 'overlay') {
    return
  }
  clearTimeout(dismissal)
  dismissal = undefined
  if (m.overlay?.isConnected) {
    if (m.restore && !m.restore.isConnected) {
      (m.overlay.getRootNode() as ShadowRoot).append(m.restore)
    }
    return
  }
  const host = document.createElement(m.themeTarget.localName)
  document.body.append(host)
  Object.assign(m, overlayMount(m.state, host))
  activate(m)
}

interface RerenderOptions {
  /** Leave focus where it is, unless it was inside the overlay. */
  quiet?: boolean
  /** Update the report on screen: quietly, keeping the scroll position and announcing nothing. */
  inPlace?: boolean
  /** Announced instead of the report itself. */
  announcement?: string
}

function rerender(m: Mount, report: ErrorReport, history?: HistoryEntry[], options: RerenderOptions = {}): void {
  const error = m.error
  const scroll = m.root.scrollTop
  const root = m.root.getRootNode() as Document | ShadowRoot
  const focused = [m.root, m.overlay].some(el => el?.contains(root.activeElement))
  revive(m)
  m.error = error
  m.selected = undefined
  m.state.report = report
  if (history) {
    m.state.history = history
  }
  const logs = childNodesOf(m.root.querySelector('[data-log-list]'))
  const logFilter = m.root.querySelector<HTMLSelectElement>('[data-log-filter]')?.value ?? ''
  const logsOpen = !m.root.querySelector('[data-logs]')?.hasAttribute('hidden')
  const toasts = childNodesOf(m.root.querySelector('[data-toasts]'))
  m.root.innerHTML = renderView(m.state)
  m.root.querySelector('[data-fallback]')?.remove()
  if (logs.length) {
    m.root.querySelector('[data-log-list]')?.replaceChildren(...logs)
  }
  const filter = m.root.querySelector<HTMLSelectElement>('[data-log-filter]')
  if (filter)
    filter.value = logFilter
  if (logsOpen) {
    m.root.querySelector('[data-logs]')?.removeAttribute('hidden')
    m.root.querySelector('[data-action="logs"]')?.setAttribute('aria-pressed', 'true')
  }
  markScrollableLogs(m)
  if (toasts.length) {
    m.root.querySelector('[data-toasts]')?.replaceChildren(...toasts)
  }
  updateBadges(m)
  setLive(m, connected)
  markOverflowingSnippets(m)
  applyMode(m)
  m.root.scrollTop = options.inPlace ? scroll : 0
  if (!options.inPlace) {
    announce(m, options.announcement ?? headline(report))
  }
  if (focused || !(options.quiet || options.inPlace)) {
    focusHeading(m)
  }
}

function headline(report: ErrorReport): string {
  return `${report.kind === 'warning' ? 'Warning' : 'Error'}: ${report.name}: ${report.message}`
}

const labelRestores = new WeakMap<HTMLElement, () => void>()

/** An icon-only button keeps its size: it swaps its icon and accessible name instead of its text. */
function setLabel(button: HTMLElement, label: string, flag: 'copied' | 'copyFailed', iconOnly = false): () => void {
  labelRestores.get(button)?.()
  const original = button.innerHTML
  const name = button.getAttribute('aria-label')
  const title = button.getAttribute('title')
  if (iconOnly) {
    button.innerHTML = flag === 'copied' ? ICONS.check : ICONS.copy
    button.setAttribute('aria-label', label)
    button.title = label
  }
  else {
    button.textContent = label
  }
  button.dataset[flag] = ''
  const restore = () => {
    if (labelRestores.get(button) !== restore) {
      return
    }
    labelRestores.delete(button)
    button.innerHTML = original
    if (iconOnly) {
      restoreAttribute(button, 'aria-label', name)
      restoreAttribute(button, 'title', title)
    }
    delete button.dataset.copied
    delete button.dataset.copyFailed
  }
  labelRestores.set(button, restore)
  return restore
}

function restoreAttribute(el: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    el.removeAttribute(name)
  }
  else {
    el.setAttribute(name, value)
  }
}

function flash(button: HTMLElement, label: string, iconOnly = false): void {
  setTimeout(setLabel(button, label, 'copied', iconOnly), 1200)
}

/** In the host document: `execCommand` cannot act on a selection inside a shadow root. */
function selectionTextarea(text: string): HTMLTextAreaElement {
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.setAttribute('data-my-bad', '')
  area.setAttribute('aria-hidden', 'true')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;z-index:2147483647'
  document.body.append(area)
  area.focus({ preventScroll: true })
  area.select()
  return area
}

function execCommandCopy(text: string): boolean {
  const selection = document.getSelection()
  const previous = selection?.rangeCount ? selection.getRangeAt(0) : undefined
  const area = selectionTextarea(text)
  let copied = false
  try {
    copied = document.execCommand('copy')
  }
  catch {}
  area.remove()
  if (previous && selection) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return copied
}

const MANUAL_COPY_TIMEOUT = 15_000

function offerManualCopy(text: string): Promise<void> {
  return new Promise((resolve) => {
    const area = selectionTextarea(text)
    const controller = new AbortController()
    const signal = controller.signal
    const done = () => {
      if (signal.aborted) {
        return
      }
      controller.abort()
      area.remove()
      resolve()
    }
    setTimeout(done, MANUAL_COPY_TIMEOUT)
    addEventListener('keyup', (event) => {
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c')) {
        done()
      }
    }, { capture: true, signal })
    area.addEventListener('blur', done, { signal })
  })
}

const copyShortcut = () => /mac|iphone|ipad/i.test(navigator.userAgent) ? '\u2318C' : 'Ctrl+C'

async function copy(m: Mount, what: string, button: HTMLElement): Promise<void> {
  const report = reportEntries(m.state.report).find(entry => entry.path === m.selected)?.report ?? m.state.report
  const text = what === 'json'
    ? JSON.stringify(report, null, 2)
    : `${what === 'prompt' ? 'Help diagnose this error. Trace the root cause in the source, explain the failure, and propose the smallest appropriate fix. Verify the fix against the relevant behaviour.\n\n' : ''}${toMarkdown(report, { cwd: m.state.cwd })}`
  return copyText(m, text, button)
}

function copyLocation(m: Mount, button: HTMLElement): Promise<void> | undefined {
  const { dataset } = button
  const position = (file?: string, line?: string, column?: string) => file && `${file}${line ? `:${line}${column ? `:${column}` : ''}` : ''}`
  const source = position(dataset.file, dataset.line, dataset.column)
  const compiled = position(dataset.compiledFile, dataset.compiledLine, dataset.compiledColumn)
  const text = (button.closest('[data-frame]')?.hasAttribute('data-compiled') ? compiled : undefined) || source || compiled
  return text ? copyText(m, text, button, 'location') : undefined
}

/** `what` marks an icon-only button, whose feedback goes into its accessible name and the live region. */
async function copyText(m: Mount, text: string, button: HTMLElement, what?: string): Promise<void> {
  const iconOnly = what !== undefined
  const done = () => {
    flash(button, iconOnly ? `Copied ${what}` : 'Copied', iconOnly)
    if (iconOnly) {
      announce(m, `Copied ${what}: ${text}`)
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return done()
  }
  catch {}
  if (execCommandCopy(text)) {
    button.focus({ preventScroll: true })
    return done()
  }
  const prompt = `Press ${copyShortcut()}`
  const restore = setLabel(button, iconOnly ? `${prompt} to copy the ${what}` : prompt, 'copyFailed', iconOnly)
  if (iconOnly) {
    announce(m, `${prompt} to copy the ${what}`)
  }
  await offerManualCopy(text)
  restore()
}

async function open(m: Mount, file: string, line?: string, column?: string): Promise<void> {
  if (m.state.channel && actions.has('open')) {
    try {
      const res = await fetch(`${m.state.channel}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, line: line ? Number(line) : undefined, column: column ? Number(column) : undefined }),
      })
      if (res.ok) {
        return
      }
    }
    catch {}
  }
  const scheme = m.state.editor ?? 'vscode'
  const anchor = document.createElement('a')
  anchor.href = `${scheme}://file/${file.replace(/^\//, '')}${line ? `:${line}` : ''}${column ? `:${column}` : ''}`
  anchor.hidden = true
  m.root.append(anchor)
  anchor.click()
  anchor.remove()
}

async function navigateHistory(m: Mount, dir: number): Promise<void> {
  const history = m.state.history ?? []
  const target = history[pagerIndex(m.state.report, history) + dir]
  const report = target && await fetchReport(m, target.id)
  if (report) {
    rerender(m, report)
  }
}

let logCount = 0
function appendLog(m: Mount, entry: { level: string, text: string, timestamp: number }): void {
  const list = m.root.querySelector<HTMLElement>('[data-log-list]')
  if (!list) {
    return
  }
  const filter = m.root.querySelector<HTMLSelectElement>('[data-log-filter]')?.value ?? ''
  const item = document.createElement('li')
  item.className = 'mb-log'
  item.dataset.log = ''
  item.dataset.level = entry.level
  item.hidden = !passesFilter(entry.level, filter)
  item.innerHTML = `<time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="mb-log-level">${escapeHtml(entry.level)}</span><span>${escapeHtml(entry.text)}</span>`
  list.append(item)
  while (list.children.length > 500) {
    list.firstElementChild?.remove()
  }
  const scroller = list.parentElement ?? list
  scroller.scrollTop = scroller.scrollHeight
  markScrollableLogs(m)
  const drawer = m.root.querySelector('[data-logs]')
  if (drawer?.hasAttribute('hidden')) {
    logCount++
    const badge = m.root.querySelector<HTMLElement>('[data-log-count]')
    if (badge) {
      badge.textContent = String(logCount)
      badge.hidden = false
    }
  }
}

function passesFilter(level: string, filter: string): boolean {
  if (!filter) {
    return true
  }
  if (filter === 'error') {
    return level === 'error' || level === 'fatal'
  }
  return level === 'warn' || level === 'error' || level === 'fatal'
}

function toggleLogs(m: Mount, force?: boolean): void {
  const drawer = m.root.querySelector<HTMLElement>('[data-logs]')
  const button = m.root.querySelector<HTMLElement>('[data-action="logs"]')
  if (!drawer) {
    return
  }
  const show = force ?? drawer.hidden
  drawer.hidden = !show
  button?.setAttribute('aria-pressed', String(show))
  markScrollableLogs(m)
  if (show) {
    logCount = 0
    const badge = m.root.querySelector<HTMLElement>('[data-log-count]')
    if (badge) {
      badge.hidden = true
    }
  }
}

/** Dismissing the page preview lasts until the next error, never across loads. */
let previewDismissed = false

const MAX_WARNINGS = 50
const warnings = new Map<string, ErrorReport>()

/** A warning republished under an id already counted updates in place, without a new toast. */
function showWarning(m: Mount, report: ErrorReport, known: boolean): void {
  if (known) {
    if (warnings.has(report.id)) {
      warnings.set(report.id, report)
    }
    if (m.state.report.id === report.id) {
      rerender(m, report, undefined, { inPlace: true })
    }
    return updateBadges(m)
  }
  warnings.delete(report.id)
  warnings.set(report.id, report)
  while (warnings.size > MAX_WARNINGS) {
    warnings.delete(warnings.keys().next().value!)
  }
  const toasts = m.root.querySelector<HTMLElement>('[data-toasts]')
  if (toasts) {
    toasts.querySelector(`[data-toast-id="${CSS.escape(report.id)}"]`)?.remove()
    toasts.insertAdjacentHTML('beforeend', renderToast(report))
    while (toasts.children.length > 4) {
      toasts.firstElementChild?.remove()
    }
  }
  updateBadges(m)
}

/** Drop a retired warning, or every warning without an id. One on screen gives way to the error, or to the next warning. */
function retireWarning(m: Mount, id: string | undefined, before: HistoryEntry[]): void {
  for (const toast of m.root.querySelectorAll<HTMLElement>('[data-toast]')) {
    if (id === undefined || toast.dataset.toastId === id) {
      toast.remove()
    }
  }
  if (id === undefined) {
    warnings.clear()
  }
  else {
    warnings.delete(id)
  }
  const shown = m.state.report
  if (shown.kind === 'warning' && (id === undefined || shown.id === id)) {
    const next = id === undefined ? undefined : nextWarning(before, m.state.history ?? [], id)
    if (m.error) {
      rerender(m, m.error)
    }
    else if (next) {
      void showNext(m, shown, next)
    }
    else if (m.overlay) {
      dismiss(m)
    }
  }
  updatePager(m)
  updateBadges(m)
}

/** The warning after a retired one, or the newest one left when it was the last. */
function nextWarning(before: HistoryEntry[], after: HistoryEntry[], id: string): HistoryEntry | undefined {
  const left = after.filter(entry => entry.kind === 'warning')
  const later = before.slice(before.findIndex(entry => entry.id === id) + 1)
  return left.find(entry => later.some(other => other.id === entry.id)) ?? left.at(-1)
}

async function showNext(m: Mount, retired: ErrorReport, entry: HistoryEntry): Promise<void> {
  const report = warnings.get(entry.id) ?? await fetchReport(m, entry.id)
  if (m.state.report !== retired) {
    return
  }
  if (!m.state.history?.some(other => other.id === entry.id)) {
    const newest = m.state.history?.filter(other => other.kind === 'warning').at(-1)
    return newest ? showNext(m, retired, newest) : m.overlay ? dismiss(m) : undefined
  }
  if (!report) {
    return m.overlay ? dismiss(m) : undefined
  }
  m.root.querySelector(`[data-toast-id="${CSS.escape(report.id)}"]`)?.remove()
  rerender(m, report, undefined, { quiet: true, announcement: `Warning fixed. Next, ${headline(report)}` })
}

async function fetchReport(m: Mount, id: string): Promise<ErrorReport | undefined> {
  if (!m.state.channel) {
    return
  }
  try {
    const res = await fetch(`${m.state.channel}/history/${encodeURIComponent(id)}?${scopeQuery(m)}`)
    return res.ok ? await res.json() : undefined
  }
  catch {}
}

function updateBadges(m: Mount): void {
  const count = m.root.querySelector<HTMLElement>('[data-warning-count]')
  if (count) {
    count.textContent = warningLabel(m.state.history)
    count.hidden = warningCount(m.state.history) === 0
  }
  const badge = m.root.querySelector<HTMLElement>('[data-log-count]')
  if (badge) {
    badge.textContent = String(logCount)
    badge.hidden = logCount === 0
  }
}

function scopeQuery(m: Mount): URLSearchParams {
  const query = new URLSearchParams({ path: `${location.pathname}${location.search}` })
  if (m.state.requestId) {
    query.set('requestId', m.state.requestId)
  }
  return query
}

/** The channel only sends this page the errors its own request produced, and those from no request at all. */
function eventsUrl(m: Mount): string {
  return `${m.state.channel}/events?${scopeQuery(m)}`
}

function updatePager(m: Mount): void {
  const pager = m.root.querySelector('[data-pager]')
  if (pager) {
    pager.outerHTML = renderPager(m.state.report, m.state.history)
  }
}

function connect(m: Mount): void {
  const base = m.state.channel
  if (!base || typeof EventSource === 'undefined') {
    return
  }
  window.__MY_BAD_CLIENT__ = true
  const url = new URL(eventsUrl(m), location.href).href
  const shared = window.__MY_BAD_SOURCE__
  const source: EventTarget & { close: () => void } = shared && new URL(shared.url).pathname === new URL(url).pathname ? shared : new EventSource(url)
  source.addEventListener('open', () => setLive(m, true))
  source.addEventListener('error', () => setLive(m, false))
  const on = <T extends ChannelEvent['type']>(type: T, handler: (payload: Extract<ChannelEvent, { type: T }>['payload']) => void) => {
    source.addEventListener(type, (event) => {
      try {
        handler(JSON.parse((event as MessageEvent).data))
      }
      catch {}
    })
  }
  on('hello', (payload) => {
    actions.clear()
    for (const action of payload.actions) {
      actions.add(action)
    }
    if (payload.current) {
      m.error = payload.current
    }
    if (payload.current && payload.current.id !== m.state.report.id) {
      rerender(m, payload.current, payload.history)
    }
    else if (payload.history) {
      m.state.history = payload.history
      updatePager(m)
      updateBadges(m)
    }
  })
  on('history', (payload) => {
    m.state.history = payload.history
    updatePager(m)
  })
  on('error:set', (payload) => {
    previewDismissed = false
    m.error = payload.report
    rerender(m, payload.report, payload.history)
    const bar = m.root.querySelector<HTMLElement>('[data-progress]')
    if (bar) {
      bar.hidden = true
    }
    if (m.overlay) {
      setHidden(m, false)
    }
  })
  on('error:clear', () => {
    m.error = undefined
    if (m.overlay) {
      dismiss(m)
    }
    else {
      source.close()
      location.reload()
    }
  })
  on('build', (payload) => {
    const bar = m.root.querySelector<HTMLElement>('[data-progress]')
    if (!bar) {
      return
    }
    const done = payload.percent !== undefined && payload.percent >= 100
    bar.hidden = done
    bar.toggleAttribute('data-indeterminate', payload.percent === undefined)
    if (payload.percent !== undefined) {
      bar.style.setProperty('--mb-progress', `${Math.max(0, Math.min(100, payload.percent))}%`)
      bar.setAttribute('aria-valuenow', String(Math.round(payload.percent)))
    }
    else {
      bar.removeAttribute('aria-valuenow')
    }
    const label = bar.querySelector<HTMLElement>('[data-progress-label]')
    if (label) {
      label.textContent = payload.message ?? payload.phase
    }
  })
  on('warning', (payload) => {
    const known = !!m.state.history?.some(entry => entry.id === payload.report.id)
    m.state.history = payload.history
    showWarning(m, payload.report, known)
    updatePager(m)
  })
  on('warning:clear', (payload) => {
    const before = m.state.history ?? []
    m.state.history = payload.history
    retireWarning(m, payload.id, before)
  })
  on('log', payload => appendLog(m, payload))
  shared?.addEventListener('show', (event) => {
    try {
      const { report, history } = JSON.parse((event as MessageEvent).data) as { report: ErrorReport, history: HistoryEntry[] }
      m.error = errorOf(report) ?? m.error
      rerender(m, report, history)
      setHidden(m, false)
      setMinimized(m, false, { persist: false })
    }
    catch {}
  })
  shared?.dispatchEvent(new Event('attach'))
  notifyBadge(m)
}

/* Overlay chrome */

/** Fade out and remove the overlay host; `revive` rebuilds it. */
function dismiss(m: Mount): void {
  const host = (m.overlay?.getRootNode() as ShadowRoot | undefined)?.host
  m.overlay?.setAttribute('data-hidden', '')
  lockPage(m, false)
  m.restore?.remove()
  clearTimeout(dismissal)
  dismissal = setTimeout(() => host?.remove(), 250)
  notifyBadge(m)
}

function setMinimized(m: Mount, value: boolean, options: { persist?: boolean } = {}): void {
  const { persist = true } = options
  if (!m.overlay) {
    return
  }
  if (m.overlay.hasAttribute('data-minimized') === value) {
    return applyMode(m)
  }
  m.overlay.toggleAttribute('data-minimized', value)
  if (value) {
    m.overlay.querySelector<HTMLElement>('[data-action="expand"]')?.focus({ preventScroll: true })
  }
  else {
    focusHeading(m)
  }
  if (persist) {
    storage(STORAGE.minimized, value ? '1' : '0')
  }
  applyMode(m)
}

const LABELS = {
  error: { name: 'Error details', hide: 'Hide error overlay', expand: 'Show error details', restore: 'Show error overlay', minimize: ['Minimise (show the page behind)', 'Minimise overlay and show the page behind'] },
  panel: { name: 'Details', hide: 'Hide overlay', expand: 'Show details', restore: 'Show overlay', minimize: ['Minimise', 'Minimise overlay'] },
}

/**
 * With an error, the expanded overlay is a modal dialog over the page. Without one, it is a panel beside the page,
 * which stays usable.
 */
function applyMode(m: Mount): void {
  const overlay = m.overlay
  if (!overlay) {
    return
  }
  const panel = !m.error
  const labels = panel ? LABELS.panel : LABELS.error
  const minimized = overlay.hasAttribute('data-minimized')
  overlay.toggleAttribute('data-panel', panel)
  overlay.setAttribute('aria-modal', String(!minimized && !panel))
  overlay.setAttribute('aria-label', panel && m.state.report.kind === 'warning' ? 'Warning details' : labels.name)
  for (const [action, label] of [['hide', labels.hide], ['expand', labels.expand]]) {
    const button = overlay.querySelector(`.mb-pip-button[data-action="${action}"]`)
    button?.setAttribute('aria-label', label!)
    button?.setAttribute('title', label!)
  }
  const tool = m.root.querySelector('.mb-tools [data-action="minimize"]')
  tool?.setAttribute('title', labels.minimize[0]!)
  tool?.setAttribute('aria-label', labels.minimize[1]!)
  if (m.restore) {
    m.restore.textContent = labels.restore
  }
  const toggle = m.preview?.querySelector('[data-action="minimize"]')
  const page = m.state.report.kind === 'warning' ? 'Show page' : 'Show page behind this error'
  toggle?.setAttribute('title', page)
  toggle?.setAttribute('aria-label', page)
  lockPage(m, !panel && !minimized && !overlay.hasAttribute('data-hidden'))
  updatePreview(m)
}

let locked: boolean | undefined

/** While the modal overlay is up, the page behind must neither scroll nor take focus. */
function lockPage(m: Mount, lock: boolean): void {
  const host = (m.overlay?.getRootNode() as ShadowRoot | undefined)?.host
  if (!host || lock === locked) {
    return
  }
  if (locked !== undefined || lock) {
    document.documentElement.style.overflow = lock ? 'hidden' : ''
  }
  locked = lock
  for (const child of document.body.children) {
    if (child !== host && !child.hasAttribute('data-my-bad') && child.tagName !== 'SCRIPT') {
      child.toggleAttribute('inert', lock)
    }
  }
}

/** Keep the thumbnail at the viewport's aspect ratio and scale the snapshot to fit it. */
function sizePreview(m: Mount): void {
  const frame = m.preview?.querySelector<HTMLIFrameElement>('iframe')
  if (!m.preview || !frame) {
    return
  }
  const scale = Math.min(240 / innerWidth, 0.28)
  m.preview.style.width = `${Math.round(innerWidth * scale)}px`
  m.preview.style.height = `${Math.round(innerHeight * scale)}px`
  m.overlay?.style.setProperty('--mb-preview-height', m.preview.style.height)
  frame.style.width = `${innerWidth}px`
  frame.style.height = `${innerHeight}px`
  frame.style.transform = `scale(${scale})`
}

/** Snapshot the host document into the preview iframe, minus scripts and the overlay itself. */
function updatePreview(m: Mount): void {
  if (!m.preview || !m.overlay) {
    return
  }
  const show = !m.overlay.hasAttribute('data-minimized') && !m.overlay.hasAttribute('data-hidden') && !m.overlay.hasAttribute('data-panel') && !previewDismissed
  m.preview.hidden = !show
  m.overlay.toggleAttribute('data-has-preview', show)
  if (!show) {
    return
  }
  sizePreview(m)
  const frame = m.preview.querySelector<HTMLIFrameElement>('iframe')
  const host = (m.overlay.getRootNode() as ShadowRoot).host
  const clone = document.documentElement.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll(`script, ${host.tagName.toLowerCase()}, [data-my-bad]`)) {
    node.remove()
  }
  const base = document.createElement('base')
  base.href = location.href
  clone.querySelector('head')?.prepend(base)
  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : ''
  const html = `${doctype}${clone.outerHTML}`
  if (frame && frame.dataset.snapshot !== String(html.length)) {
    frame.srcdoc = html
    frame.dataset.snapshot = String(html.length)
  }
}

function setHidden(m: Mount, value: boolean): void {
  if (!m.overlay || !m.restore) {
    return
  }
  m.overlay.toggleAttribute('data-hidden', value)
  m.overlay.toggleAttribute('inert', value)
  m.restore.hidden = !value
  session(hiddenKey(m.state.cwd), value ? '1' : '0')
  applyMode(m)
  notifyBadge(m)
}

/** With a badge on the page, the badge stands in for the restore button while the overlay is out of sight. */
function notifyBadge(m: Mount): void {
  const shared = window.__MY_BAD_SOURCE__
  if (shared && m.restore) {
    m.restore.hidden = true
  }
  shared?.dispatchEvent(new Event('overlay'))
}

function setDock(m: Mount, dock: Dock): void {
  m.overlay?.setAttribute('data-dock', dock)
  m.preview?.setAttribute('data-dock', dock)
  storage(STORAGE.dock, dock)
}

/** Drag to any corner. A press without movement is reported as a tap; a real drag swallows the click. */
function draggable(m: Mount, el: HTMLElement, enabled: () => boolean, onTap?: () => void): void {
  let drag: { x: number, y: number, moved: boolean } | undefined
  let dragged = false
  el.addEventListener('pointerdown', (event) => {
    if (!enabled() || (event.target as HTMLElement).closest('[data-action="hide"], [data-action="hide-preview"]')) {
      return
    }
    drag = { x: event.clientX, y: event.clientY, moved: false }
    el.setPointerCapture(event.pointerId)
  })
  el.addEventListener('pointermove', (event) => {
    if (!drag) {
      return
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) {
      return
    }
    drag.moved = true
    el.setAttribute('data-dragging', '')
    el.style.translate = `${event.clientX - drag.x}px ${event.clientY - drag.y}px`
  })
  const end = (event: PointerEvent) => {
    if (!drag) {
      return
    }
    dragged = drag.moved
    drag = undefined
    el.removeAttribute('data-dragging')
    el.style.translate = ''
    if (dragged) {
      const horizontal = event.clientX < innerWidth / 2 ? 'left' : 'right'
      const vertical = event.clientY < innerHeight / 2 ? 'top' : 'bottom'
      setDock(m, `${vertical}-${horizontal}` as Dock)
    }
    else if (event.type === 'pointerup') {
      onTap?.()
    }
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('click', (event) => {
    if (dragged) {
      dragged = false
      event.stopPropagation()
      event.preventDefault()
    }
  }, true)
}

function setupOverlay(m: Mount): void {
  const overlay = m.overlay!
  const dock = (storage(STORAGE.dock) as Dock | null) ?? m.state.dock ?? 'bottom-right'
  overlay.setAttribute('data-dock', dock)
  m.preview?.setAttribute('data-dock', dock)
  const minimized = storage(STORAGE.minimized)
  setMinimized(m, !!m.state.startMinimized || minimized === '1', { persist: false })
  setHidden(m, session(hiddenKey(m.state.cwd)) === '1')

  draggable(m, overlay, () => overlay.hasAttribute('data-minimized'), () => setMinimized(m, false))
  if (m.preview) {
    draggable(m, m.preview, () => true, () => setMinimized(m, true))
  }
  overlay.addEventListener('keydown', (event) => {
    const layered = m.root.querySelector('dialog[open], [data-menu-list]:not([hidden])') || (event.target as HTMLElement).closest('[data-toast]')
    if (event.key === 'Escape' && !overlay.hasAttribute('data-minimized') && !layered) {
      setMinimized(m, true)
    }
    const arrows: Record<string, (dock: Dock) => Dock> = {
      ArrowLeft: dock => dock.replace('right', 'left') as Dock,
      ArrowRight: dock => dock.replace('left', 'right') as Dock,
      ArrowUp: dock => dock.replace('bottom', 'top') as Dock,
      ArrowDown: dock => dock.replace('top', 'bottom') as Dock,
    }
    if (overlay.hasAttribute('data-minimized') && arrows[event.key]) {
      event.preventDefault()
      setDock(m, arrows[event.key]!(currentDock(m)))
    }
  })
}

function currentDock(m: Mount): Dock {
  return (m.overlay?.getAttribute('data-dock') as Dock | null) ?? 'bottom-right'
}

/** The log drawer is a tab stop only when it actually scrolls. */
function markScrollableLogs(m: Mount): void {
  const list = m.root.querySelector<HTMLElement>('[data-log-list]')
  const empty = m.root.querySelector<HTMLElement>('[data-log-empty]')
  if (empty) {
    empty.hidden = !!list?.querySelector('[data-log]:not([hidden])')
    empty.textContent = list?.childElementCount ? 'No logs match this level.' : 'No logs received yet.'
  }
  const scroller = list?.parentElement
  if (!scroller) {
    return
  }
  if (scroller.scrollHeight > scroller.clientHeight + 1) {
    scroller.setAttribute('tabindex', '0')
  }
  else {
    scroller.removeAttribute('tabindex')
  }
}

/** `<pre>` is only a tab stop when it actually scrolls. */
function markOverflowingSnippets(m: Mount): void {
  for (const pre of m.root.querySelectorAll<HTMLElement>('pre[data-snippet], pre.mb-snippet')) {
    if (pre.scrollWidth > pre.clientWidth + 1) {
      pre.setAttribute('tabindex', '0')
    }
    else {
      pre.removeAttribute('tabindex')
    }
  }
}

function closeMenus(m: Mount, options: { except?: Element, focusFrom?: Element } = {}): void {
  for (const menu of m.root.querySelectorAll<HTMLDetailsElement>('.mb-cause-picker[open], .mb-history[open]')) {
    if (options.except && menu.contains(options.except))
      continue
    menu.open = false
    if (options.focusFrom && menu.contains(options.focusFrom))
      menu.querySelector('summary')?.focus()
  }
  for (const list of m.root.querySelectorAll<HTMLElement>('[data-menu-list]')) {
    if (list === options.except || list.hidden) {
      continue
    }
    list.hidden = true
    const trigger = list.previousElementSibling as HTMLElement | null
    trigger?.setAttribute('aria-expanded', 'false')
    if (options.focusFrom && list.contains(options.focusFrom)) {
      trigger?.focus()
    }
  }
}

function openInfo(m: Mount): void {
  const dialog = m.root.querySelector<HTMLDialogElement>('[data-info]')
  if (dialog && !dialog.open) {
    dialog.showModal()
  }
}

function bind(m: Mount): void {
  const container = m.overlay?.parentNode ?? m.root
  container.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).matches?.('dialog[open]')) {
      (event.target as HTMLDialogElement).close()
      return
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target || !container.contains(target)) {
      return
    }
    const action = target.dataset.action
    switch (action) {
      case 'theme':
        return toggleTheme(m)
      case 'copy-menu': {
        const list = target.nextElementSibling
        if (!(list instanceof HTMLElement)) {
          return
        }
        const show = list.hidden
        closeMenus(m, { except: list })
        list.hidden = !show
        target.setAttribute('aria-expanded', String(show))
        return
      }
      case 'copy': {
        void copy(m, target.dataset.copy ?? 'markdown', target)
        setTimeout(closeMenus, 1200, m)
        return
      }
      case 'copy-location':
        return void copyLocation(m, target)
      case 'open':
        return void open(m, target.dataset.file!, target.dataset.line, target.dataset.column)
      case 'cause': {
        const selected = reportEntries(m.state.report).find(entry => entry.path === target.dataset.path)
        if (!selected)
          return
        m.selected = selected.path
        const view = document.createElement('div')
        view.innerHTML = renderView(m.state, m.selected)
        const article = view.querySelector('.mb-report')
        if (!article) {
          return
        }
        m.root.querySelector('.mb-report')?.replaceWith(article)
        markOverflowingSnippets(m)
        announce(m, `${selected.label}: ${selected.report.name}: ${selected.report.message}`)
        focusHeading(m)
        return
      }
      case 'expand-message': {
        const rest = target.closest('[data-message]')?.querySelector('[data-message-rest]')
        rest?.removeAttribute('hidden')
        target.remove()
        return
      }
      case 'context': {
        const frame = target.closest<HTMLElement>('[data-frame]')
        if (!frame) {
          return
        }
        const expanded = frame.toggleAttribute('data-expanded')
        target.setAttribute('aria-expanded', String(expanded))
        const label = expanded ? 'Less context' : 'More context'
        target.setAttribute('aria-label', label)
        target.title = label
        markOverflowingSnippets(m)
        return
      }
      case 'stack': {
        const list = target.closest('[data-stack]')?.querySelector<HTMLElement>('.mb-frames')
        if (!list) {
          return
        }
        list.hidden = !list.hidden
        target.setAttribute('aria-expanded', String(!list.hidden))
        markOverflowingSnippets(m)
        return
      }
      case 'framework': {
        const stack = target.closest('[data-stack]')
        if (!stack) {
          return
        }
        target.setAttribute('aria-checked', String(stack.toggleAttribute('data-framework')))
        markOverflowingSnippets(m)
        return
      }
      case 'toggle-compiled': {
        const frame = target.closest<HTMLElement>('[data-frame]')
        const source = frame?.querySelector<HTMLElement>('[data-snippet-source]')
        const compiled = frame?.querySelector<HTMLElement>('[data-snippet-compiled]')
        if (!frame || !source || !compiled) {
          return
        }
        const on = target.dataset.switch === 'compiled'
        frame.toggleAttribute('data-compiled', on)
        source.hidden = on
        compiled.hidden = !on
        for (const button of frame.querySelectorAll<HTMLElement>('[data-switch]')) {
          button.setAttribute('aria-pressed', String((button.dataset.switch === 'compiled') === on))
        }
        markOverflowingSnippets(m)
        return
      }
      case 'info':
        return openInfo(m)
      case 'close-info':
        return m.root.querySelector<HTMLDialogElement>('[data-info]')?.close()
      case 'logs':
        return toggleLogs(m)
      case 'clear-logs': {
        const list = m.root.querySelector('[data-log-list]')
        if (list) {
          list.innerHTML = ''
        }
        logCount = 0
        updateBadges(m)
        markScrollableLogs(m)
        return
      }
      case 'history':
        return void navigateHistory(m, Number(target.dataset.dir))
      case 'dismiss-toast': {
        event.stopPropagation()
        const toast = target.closest<HTMLElement>('[data-toast]')
        if (toast?.dataset.toastId) {
          warnings.delete(toast.dataset.toastId)
        }
        return toast?.remove()
      }
      case 'show-toast': {
        const toast = target.closest<HTMLElement>('[data-toast]')
        const warning = toast && warnings.get(toast.dataset.toastId!)
        if (warning) {
          toast.remove()
          warnings.delete(warning.id)
          rerender(m, warning)
        }
        return
      }
      case 'minimize':
        return setMinimized(m, true)
      case 'hide':
        event.stopPropagation()
        return setHidden(m, true)
      case 'restore':
        return setHidden(m, false)
      case 'expand':
        event.stopPropagation()
        return setMinimized(m, false)
      case 'hide-preview':
        event.stopPropagation()
        previewDismissed = true
        return updatePreview(m)
    }
  })
  container.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('[data-menu], .mb-cause-picker, .mb-history')) {
      closeMenus(m)
    }
  })
  container.addEventListener('toggle', () => markOverflowingSnippets(m), true)
  container.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement
    if (select.matches('[data-log-filter]')) {
      for (const item of m.root.querySelectorAll<HTMLElement>('[data-log]')) {
        item.hidden = !passesFilter(item.dataset.level ?? '', select.value)
      }
      markScrollableLogs(m)
    }
  })
  container.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent
    const target = key.target as HTMLElement
    if (key.key === 'Escape') {
      closeMenus(m, { focusFrom: target })
      const toast = target.closest<HTMLElement>('[data-toast]')
      if (toast) {
        if (toast.dataset.toastId) {
          warnings.delete(toast.dataset.toastId)
        }
        toast.remove()
        m.root.querySelector<HTMLElement>('main')?.focus()
      }
    }
  })
}

/** Wire up a freshly built view. Window-level listeners stay outside, so reviving does not stack them. */
function activate(m: Mount): void {
  m.root.querySelector('[data-fallback]')?.remove()
  applyTheme(m)
  bind(m)
  if (m.overlay) {
    setupOverlay(m)
  }
  markOverflowingSnippets(m)
  if (!m.overlay?.hasAttribute('data-minimized')) {
    focusHeading(m)
  }
}

const m = mount()
if (m) {
  activate(m)
  addEventListener('resize', () => {
    markOverflowingSnippets(m)
    sizePreview(m)
  })
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', () => connect(m), { once: true })
  }
  else {
    connect(m)
  }
}

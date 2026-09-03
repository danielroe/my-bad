import type { ChannelEvent } from '../../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../../types'
import type { PageState } from '../state'
import { toMarkdown } from '../../../report/markdown'
import { escapeHtml } from '../escape'
import { ICONS, renderToast, renderView } from '../view'

declare global {
  interface Window { __MY_BAD__?: PageState & { styles?: string } }
}

const STORAGE = {
  theme: 'my-bad:theme',
  dock: 'my-bad:overlay:dock',
  minimized: 'my-bad:overlay:minimized',
  hidden: 'my-bad:overlay:hidden',
}

type Dock = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'

let connected = false
const actions = new Set<string>()

interface Mount {
  state: PageState
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

function readState(): (PageState & { styles?: string }) | undefined {
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
  try {
    if (value === undefined) {
      return localStorage.getItem(key)
    }
    if (value === null) {
      localStorage.removeItem(key)
    }
    else {
      localStorage.setItem(key, value)
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
    const host = (document.currentScript?.previousElementSibling?.previousElementSibling as HTMLElement | null) ?? document.querySelector(state.tag ?? 'my-bad-overlay')
    if (!host) {
      return
    }
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = state.styles ?? ''
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
    shadow.append(style, overlay, restore)
    return { state, themeTarget: host, root, overlay, restore, preview }
  }
  const root = document.querySelector<HTMLElement>('[data-my-bad-root]')
  if (!root) {
    return
  }
  return { state, themeTarget: document.documentElement, root }
}

function applyTheme(m: Mount): void {
  const forced = m.state.theme?.scheme
  const stored = storage(STORAGE.theme)
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

function rerender(m: Mount, report: ErrorReport, history?: HistoryEntry[]): void {
  m.state.report = report
  if (history) {
    m.state.history = history
  }
  const logs = m.root.querySelector('[data-log-list]')?.innerHTML
  const logsOpen = !m.root.querySelector('[data-logs]')?.hasAttribute('hidden')
  const toasts = m.root.querySelector('[data-toasts]')?.innerHTML
  m.root.innerHTML = renderView(m.state)
  if (logs) {
    const list = m.root.querySelector('[data-log-list]')
    if (list) {
      list.innerHTML = logs
    }
    if (logsOpen) {
      m.root.querySelector('[data-logs]')?.removeAttribute('hidden')
    }
  }
  if (toasts) {
    const container = m.root.querySelector('[data-toasts]')
    if (container) {
      container.innerHTML = toasts
    }
  }
  updateBadges(m)
  setLive(m, connected)
  markOverflowingSnippets(m)
  m.root.scrollTop = 0
  announce(m, `${report.kind === 'warning' ? 'Warning' : 'Error'}: ${report.name}: ${report.message}`)
  focusHeading(m)
}

async function copy(m: Mount, what: string, button: HTMLElement): Promise<void> {
  const { report } = m.state
  const text = what === 'markdown'
    ? toMarkdown(report, { cwd: m.state.cwd })
    : what === 'stack'
      ? report.rawStack ?? `${report.name}: ${report.message}`
      : what === 'json'
        ? JSON.stringify(report, null, 2)
        : report.message
  try {
    await navigator.clipboard.writeText(text)
    const original = button.textContent
    button.textContent = 'Copied'
    button.dataset.copied = ''
    setTimeout(() => {
      button.textContent = original
      delete button.dataset.copied
    }, 1200)
  }
  catch {}
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
  const index = history.findIndex(entry => entry.id === m.state.report.id)
  const target = history[index + dir]
  if (!target || !m.state.channel) {
    return
  }
  try {
    const res = await fetch(`${m.state.channel}/history/${encodeURIComponent(target.id)}`)
    if (res.ok) {
      rerender(m, await res.json())
    }
  }
  catch {}
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
let warningCount = 0

function showWarning(m: Mount, report: ErrorReport): void {
  if (!warnings.has(report.id)) {
    warningCount++
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

/** Re-apply counters that the server-rendered markup emits in their empty state. */
function updateBadges(m: Mount): void {
  const count = m.root.querySelector<HTMLElement>('[data-warning-count]')
  if (count) {
    count.textContent = `${warningCount} warning${warningCount === 1 ? '' : 's'}`
    count.hidden = warningCount === 0
  }
  const badge = m.root.querySelector<HTMLElement>('[data-log-count]')
  if (badge) {
    badge.textContent = String(logCount)
    badge.hidden = logCount === 0
  }
}

function connect(m: Mount): void {
  const base = m.state.channel
  if (!base || typeof EventSource === 'undefined') {
    return
  }
  const source = new EventSource(`${base}/events`)
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
    if (payload.current && payload.current.id !== m.state.report.id) {
      rerender(m, payload.current, payload.history)
    }
    else if (payload.history) {
      m.state.history = payload.history
    }
  })
  on('error:set', (payload) => {
    previewDismissed = false
    rerender(m, payload.report, payload.history)
    const bar = m.root.querySelector<HTMLElement>('[data-progress]')
    if (bar) {
      bar.hidden = true
    }
    if (m.overlay) {
      setMinimized(m, false)
      setHidden(m, false)
    }
  })
  on('error:clear', () => {
    if (m.overlay) {
      m.overlay.setAttribute('data-hidden', '')
      setHostInert(m, false)
      m.restore?.remove()
      setTimeout(() => (m.overlay?.getRootNode() as ShadowRoot | undefined)?.host?.remove(), 250)
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
    m.state.history = payload.history
    showWarning(m, payload.report)
  })
  on('log', payload => appendLog(m, payload))
}

/* Overlay chrome */

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function setMinimized(m: Mount, value: boolean, animate = true): void {
  if (!m.overlay) {
    return
  }
  if (m.overlay.hasAttribute('data-minimized') === value) {
    return updatePreview(m)
  }
  const swap = () => {
    m.overlay!.toggleAttribute('data-minimized', value)
    if (value) {
      m.overlay!.querySelector<HTMLElement>('[data-action="expand"]')?.focus({ preventScroll: true })
    }
    else {
      focusHeading(m)
    }
    m.overlay!.setAttribute('aria-modal', String(!value))
    storage(STORAGE.minimized, value ? '1' : '0')
    document.documentElement.style.overflow = value ? '' : 'hidden'
    setHostInert(m, !value && !m.overlay!.hasAttribute('data-hidden'))
    updatePreview(m)
  }
  if (!animate || reducedMotion() || !m.preview || m.preview.hidden === value) {
    return swap()
  }
  zoomPreview(m, value, swap)
}

/** While maximised the overlay is a modal dialog, so the page behind must not be focusable. */
function setHostInert(m: Mount, inert: boolean): void {
  const host = (m.overlay?.getRootNode() as ShadowRoot | undefined)?.host
  if (!host) {
    return
  }
  for (const child of document.body.children) {
    if (child !== host && !child.hasAttribute('data-my-bad') && child.tagName !== 'SCRIPT') {
      child.toggleAttribute('inert', inert)
    }
  }
}

/** Scale the page behind uniformly between thumbnail and viewport, which share an aspect ratio. */
function zoomPreview(m: Mount, minimize: boolean, swap: () => void): void {
  const preview = m.preview!
  const overlay = m.overlay!
  const rect = preview.getBoundingClientRect()
  const full = `translate(${-rect.left}px, ${-rect.top}px) scale(${innerWidth / rect.width})`
  const options: KeyframeAnimationOptions = { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' }
  preview.style.transformOrigin = '0 0'
  preview.setAttribute('data-zooming', '')
  const done = () => {
    preview.removeAttribute('data-zooming')
    preview.style.transformOrigin = ''
  }
  if (minimize) {
    const zoom = preview.animate([{ transform: 'none' }, { transform: full }], options)
    const fade = overlay.animate([{ opacity: 1 }, { opacity: 0.4 }], options)
    zoom.onfinish = () => {
      swap()
      zoom.cancel()
      fade.cancel()
      done()
      overlay.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' })
    }
  }
  else {
    swap()
    const zoom = preview.animate([{ transform: full }, { transform: 'none' }], options)
    const fade = overlay.animate([{ opacity: 0 }, { opacity: 1 }], options)
    zoom.onfinish = () => {
      zoom.cancel()
      fade.cancel()
      done()
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
  frame.style.width = `${innerWidth}px`
  frame.style.height = `${innerHeight}px`
  frame.style.transform = `scale(${scale})`
}

/** Snapshot the host document into the preview iframe, minus scripts and the overlay itself. */
function updatePreview(m: Mount): void {
  if (!m.preview || !m.overlay) {
    return
  }
  const show = !m.overlay.hasAttribute('data-minimized') && !m.overlay.hasAttribute('data-hidden') && !previewDismissed
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
  storage(STORAGE.hidden, value ? '1' : '0')
  setHostInert(m, !value && !m.overlay.hasAttribute('data-minimized'))
  updatePreview(m)
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
  const dock = (storage(STORAGE.dock) as Dock | null) ?? 'bottom-right'
  overlay.setAttribute('data-dock', dock)
  m.preview?.setAttribute('data-dock', dock)
  const minimized = storage(STORAGE.minimized)
  setMinimized(m, minimized === null ? !!m.state.startMinimized : minimized === '1', false)
  setHidden(m, storage(STORAGE.hidden) === '1')

  draggable(m, overlay, () => overlay.hasAttribute('data-minimized'), () => setMinimized(m, false))
  if (m.preview) {
    draggable(m, m.preview, () => true, () => setMinimized(m, true))
  }
  addEventListener('resize', () => sizePreview(m))
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
  const scroller = m.root.querySelector<HTMLElement>('[data-log-list]')?.parentElement
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
    let target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target) {
      const head = (event.target as HTMLElement).closest<HTMLElement>('.mb-frame-head')
      target = head?.querySelector<HTMLElement>('[data-frame-toggle]') ?? null
      if (!target || (window.getSelection()?.toString() ?? '')) {
        return
      }
    }
    if (!container.contains(target)) {
      return
    }
    const action = target.dataset.action
    switch (action) {
      case 'theme':
        return toggleTheme(m)
      case 'copy-menu': {
        const list = target.nextElementSibling as HTMLElement
        const show = list.hidden
        closeMenus(m, { except: list })
        list.hidden = !show
        target.setAttribute('aria-expanded', String(show))
        return
      }
      case 'copy': {
        void copy(m, target.dataset.copy ?? 'message', target)
        setTimeout(closeMenus, 1200, m)
        return
      }
      case 'open':
        return void open(m, target.dataset.file!, target.dataset.line, target.dataset.column)
      case 'toggle-frame': {
        const body = target.closest('[data-frame]')?.querySelector<HTMLDetailsElement>('[data-frame-body]')
        if (body) {
          body.open = !body.open
          target.setAttribute('aria-expanded', String(body.open))
        }
        return
      }
      case 'toggle-compiled': {
        const frame = target.closest<HTMLElement>('[data-frame]') ?? target.closest<HTMLElement>('.mb-frame')
        const on = target.dataset.switch === 'compiled'
        frame?.toggleAttribute('data-compiled', on)
        const source = frame?.querySelector<HTMLElement>('[data-snippet-source]')
        const compiled = frame?.querySelector<HTMLElement>('[data-snippet-compiled]')
        if (source && compiled) {
          source.hidden = on
          compiled.hidden = !on
        }
        const body = frame?.querySelector<HTMLDetailsElement>('[data-frame-body]')
        if (body && !body.open) {
          body.open = true
          frame?.querySelector('[data-frame-toggle]')?.setAttribute('aria-expanded', 'true')
        }
        for (const button of target.parentElement?.querySelectorAll<HTMLElement>('[data-switch]') ?? []) {
          button.setAttribute('aria-pressed', String((button.dataset.switch === 'compiled') === on))
        }
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
    if (!(event.target as HTMLElement).closest('[data-menu]')) {
      closeMenus(m)
    }
  })
  container.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement
    if (select.matches('[data-log-filter]')) {
      for (const item of m.root.querySelectorAll<HTMLElement>('[data-log]')) {
        item.hidden = !passesFilter(item.dataset.level ?? '', select.value)
      }
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

const m = mount()
if (m) {
  applyTheme(m)
  bind(m)
  if (m.overlay) {
    setupOverlay(m)
  }
  markOverflowingSnippets(m)
  addEventListener('resize', () => markOverflowingSnippets(m))
  if (!m.overlay?.hasAttribute('data-minimized')) {
    focusHeading(m)
  }
  connect(m)
}

import type { ChannelEvent } from '../../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../../types'
import type { BadgeState, PageState } from '../state'
import styles from 'virtual:my-bad-badge-styles'
import { THEME_STORAGE_KEY } from '../state'

type Payload<T extends ChannelEvent['type']> = Extract<ChannelEvent, { type: T }>['payload']

const TYPES: Array<ChannelEvent['type']> = ['hello', 'error:set', 'error:clear', 'history', 'warning', 'warning:clear', 'log', 'build']

const ICONS = {
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
}

/** How long a new warning or error is spelled out next to the count. */
const LATEST_MS = 6000

interface Badge {
  host: HTMLElement
  button: HTMLButtonElement
  count: HTMLElement
  latest: HTMLElement
  status: HTMLElement
}

function readJson<T>(holder: Element | null | undefined): T | undefined {
  if (holder instanceof HTMLScriptElement && holder.type === 'application/json') {
    try {
      return JSON.parse(holder.textContent || '')
    }
    catch {}
  }
}

function whenParsed(fn: () => void): void {
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', fn, { once: true })
  }
  else {
    fn()
  }
}

function storage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function firstLine(report: ErrorReport): string {
  return `${report.name}: ${report.message.split('\n')[0]}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function start(state: BadgeState): void {
  const overlay = state.overlay
  const tag = overlay.tag ?? 'my-bad-overlay'
  const query = new URLSearchParams({ path: `${location.pathname}${location.search}` })
  if (overlay.requestId) {
    query.set('requestId', overlay.requestId)
  }
  const target: MyBadSharedSource = Object.assign(new EventTarget(), {
    url: new URL(`${overlay.channel}/events?${query}`, location.href).href,
    close: () => {},
  })
  window.__MY_BAD_SOURCE__ = target

  let source: EventSource | undefined
  let connected = false
  let hello: Payload<'hello'> = { version: '', actions: [] }
  let current: ErrorReport | undefined
  let history: HistoryEntry[] = []
  const reports = new Map<string, ErrorReport>()
  let latest: ErrorReport | undefined
  let latestTimer: ReturnType<typeof setTimeout> | undefined
  let announcement = ''
  let greeted = false
  /** The error of an overlay rendered into the page that cleared before the overlay attached. */
  let retired: string | undefined
  let attached = false
  let loading = false
  let pending: ErrorReport | undefined
  let badge: Badge | undefined

  const warnings = () => history.filter(entry => entry.kind === 'warning')
  const forward = (type: string, payload?: unknown) => target.dispatchEvent(payload === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(payload) }))

  function announce(report: ErrorReport): void {
    latest = report
    clearTimeout(latestTimer)
    latestTimer = setTimeout(() => {
      latest = undefined
      render()
    }, LATEST_MS)
    announcement = `${report.kind === 'warning' ? 'Warning' : 'Error'}: ${firstLine(report)}`
  }

  function setHistory(next: HistoryEntry[]): void {
    history = next
    for (const id of reports.keys()) {
      if (!history.some(entry => entry.id === id)) {
        reports.delete(id)
      }
    }
    if (latest?.kind === 'warning' && !reports.has(latest.id)) {
      latest = undefined
    }
  }

  /** A reconnect skips whatever happened while the stream was closed, so the overlay is told what went away. */
  function receiveHello(payload: Payload<'hello'>): void {
    if (current && !payload.current) {
      forward('error:clear', { id: current.id })
      cleared(current.id)
    }
    else if (!greeted && !payload.current) {
      whenParsed(() => retireRendered(payload.history ?? []))
    }
    greeted = true
    const next = new Set(payload.history?.map(entry => entry.id))
    for (const entry of warnings()) {
      if (!next.has(entry.id)) {
        forward('warning:clear', { id: entry.id, history: payload.history ?? [] })
      }
    }
    hello = payload
    current = payload.current
    setHistory(payload.history ?? [])
    mountError()
  }

  /** An overlay rendered into the page for an error the channel has since cleared. A report the channel never had is left alone. */
  function retireRendered(entries: HistoryEntry[]): void {
    const report = readJson<PageState>(document.querySelector(tag)?.nextElementSibling)?.report
    if (!report || report.kind === 'warning' || current || !entries.some(entry => entry.id === report.id)) {
      return
    }
    if (attached) {
      forward('error:clear', { id: report.id })
    }
    else {
      retired = report.id
    }
    cleared(report.id)
  }

  function cleared(id: string | undefined): void {
    dispatchEvent(new CustomEvent('my-bad:error:clear', { detail: { id } }))
  }

  function receive(type: ChannelEvent['type'], data: string): void {
    let payload: any
    try {
      payload = JSON.parse(data)
    }
    catch {
      return
    }
    switch (type) {
      case 'hello':
        receiveHello(payload)
        break
      case 'error:set':
        current = payload.report
        setHistory(payload.history)
        announce(payload.report)
        mountError()
        break
      case 'error:clear':
        if (latest === current) {
          latest = undefined
        }
        current = undefined
        cleared(payload.id)
        break
      case 'history':
      case 'warning:clear':
        setHistory(payload.history)
        break
      case 'warning': {
        const known = history.some(entry => entry.id === payload.report.id)
        reports.set(payload.report.id, payload.report)
        setHistory(payload.history)
        if (!known) {
          announce(payload.report)
        }
        break
      }
    }
    forward(type, payload)
    render()
  }

  function connect(): void {
    if (source) {
      return
    }
    source = new EventSource(target.url)
    source.addEventListener('open', () => {
      connected = true
      forward('open')
    })
    source.addEventListener('error', () => {
      connected = false
      forward('error')
    })
    for (const type of TYPES) {
      source.addEventListener(type, event => receive(type, (event as MessageEvent).data))
    }
  }

  /** A background tab gives its connection back, since browsers allow only a handful per host over HTTP/1.1. */
  function disconnect(): void {
    source?.close()
    source = undefined
    if (connected) {
      connected = false
      forward('error')
    }
  }

  target.addEventListener('overlay', () => render())
  target.addEventListener('attach', () => {
    attached = true
    if (connected) {
      forward('open')
    }
    forward('hello', { ...hello, current, history })
    if (pending) {
      forward('show', { report: pending, history })
      pending = undefined
    }
    if (retired) {
      forward('error:clear', { id: retired })
      retired = undefined
    }
  })

  async function latestWarning(): Promise<ErrorReport | undefined> {
    const entry = warnings().at(-1)
    if (!entry) {
      return
    }
    const known = reports.get(entry.id)
    if (known) {
      return known
    }
    try {
      const res = await fetch(`${overlay.channel}/history/${encodeURIComponent(entry.id)}?${query}`)
      return res.ok ? await res.json() : undefined
    }
    catch {}
  }

  async function expand(): Promise<void> {
    const report = current ?? await latestWarning()
    if (!report) {
      return
    }
    if (attached) {
      forward('show', { report, history })
      return
    }
    pending = report
    load(report)
  }

  /** Once the page is parsed, so an overlay rendered into it has had the chance to attach first. */
  function mountError(): void {
    whenParsed(() => {
      if (current && !attached && !document.querySelector(tag)) {
        load(current)
      }
    })
  }

  function load(report: ErrorReport): void {
    if (loading) {
      return
    }
    loading = true
    const host = document.createElement(tag)
    const json = document.createElement('script')
    json.type = 'application/json'
    json.textContent = JSON.stringify({ ...overlay, report, history } satisfies PageState)
    const script = document.createElement('script')
    script.src = state.script
    script.addEventListener('error', () => {
      loading = false
      host.remove()
      json.remove()
      script.remove()
      render()
    })
    document.body.append(host, json, script)
  }

  function scheme(): string {
    const remembered = storage(THEME_STORAGE_KEY)
    return overlay.theme?.scheme ?? (remembered === 'light' || remembered === 'dark' ? remembered : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  }

  function create(): Badge {
    const host = document.createElement(`${tag}-badge`)
    host.setAttribute('data-my-bad', '')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `${styles}${overlay.styles ?? ''}`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mb-badge'
    button.lang = 'en'
    button.innerHTML = '<span></span><span class="mb-badge-count"></span><span class="mb-badge-latest"></span>'
    button.addEventListener('click', () => void expand())
    const status = document.createElement('div')
    status.className = 'mb-sr-only'
    status.setAttribute('role', 'status')
    shadow.append(style, button, status)
    const [, count, latest] = button.children as unknown as HTMLElement[]
    return { host, button, count: count!, latest: latest!, status }
  }

  /** A host whose overlay has not been built yet counts as shown, since its script is about to build it. */
  function overlayShown(): boolean {
    const view = document.querySelector(tag)
    const dialog = view?.shadowRoot?.querySelector('[data-overlay]')
    return !!view && (!dialog || !dialog.hasAttribute('data-hidden'))
  }

  function render(): void {
    const count = warnings().length
    const show = (current || count) && !overlayShown()
    if (!show || !document.body) {
      announcement = ''
      if (badge) {
        badge.button.hidden = true
      }
      return
    }
    badge ??= create()
    if (!badge.host.isConnected) {
      document.body.append(badge.host)
    }
    const kind = current ? 'error' : 'warning'
    const summary = [current && '1 error', count && plural(count, 'warning')].filter(Boolean).join(', ')
    const detail = latest ? firstLine(latest) : ''
    const { button } = badge
    button.hidden = false
    button.dataset.kind = kind
    button.dataset.dock = storage('my-bad:overlay:dock') ?? 'bottom-right'
    button.firstElementChild!.outerHTML = ICONS[kind]
    badge.count.textContent = summary
    badge.latest.textContent = detail
    button.title = `Show ${summary}`
    badge.host.setAttribute('data-theme', scheme())
    if (announcement) {
      const { status } = badge
      const text = announcement
      announcement = ''
      setTimeout(() => (status.textContent = text), 50)
    }
  }

  document.addEventListener('visibilitychange', () => document.hidden ? disconnect() : connect())
  if (!document.hidden) {
    connect()
  }
  const watch = () => {
    new MutationObserver(render).observe(document.body, { childList: true })
    render()
  }
  if (document.body) {
    watch()
  }
  else {
    addEventListener('DOMContentLoaded', watch)
  }
}

const state = readJson<BadgeState>(document.currentScript?.previousElementSibling)
if (state?.overlay.channel && typeof EventSource !== 'undefined' && !window.__MY_BAD_CLIENT__ && !window.__MY_BAD_SOURCE__) {
  start(state)
}

import type { ChannelEvent, ProblemSet, ProblemSummary } from '../../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../../types'
import type { BadgeFocus, BadgeState, PageState } from '../state'
import styles from 'virtual:my-bad-badge-styles'
import { displayPath } from '../../../report/path'
import { THEME_STORAGE_KEY } from '../state'
import { firstLine, plural, reportLocation } from '../summary'
import { focusSender } from './frame'

type Payload<T extends ChannelEvent['type']> = Extract<ChannelEvent, { type: T }>['payload']

const TYPES: Array<ChannelEvent['type']> = [
  'hello',
  'error:set',
  'error:clear',
  'history',
  'warning',
  'warning:clear',
  'log',
  'build',
  'problems',
  'problems:clear',
]

const ICONS = {
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  checking: '<svg class="mb-spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
}

/** How long a new report is shown in full before the badge collapses back. */
const PEEK_MS = 6000

interface Badge {
  host: HTMLElement
  dock: HTMLElement
  button: HTMLButtonElement
  problems: HTMLElement
  count: HTMLElement
  peek: HTMLButtonElement
  status: HTMLElement
}

interface Peek {
  report: ErrorReport
  more: number
  /** The problem set the reports joined, or none for the current error or a warning. */
  source?: string
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

function counts(errors: number, warnings: number): string {
  return [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ')
}

function failed(set: ProblemSummary): boolean {
  return set.status === 'failed'
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
  const problems = new Map<string, ProblemSummary>()
  const problemReports = new Map<string, ErrorReport[]>()
  /** Whether the problem reports present when the page connected are known, so later ones count as new. */
  let problemsKnown = false
  let withheld = false
  let fetching = false
  let refetch = false
  let peek: Peek | undefined
  let drawn: Peek | undefined
  let peekTimer: ReturnType<typeof setTimeout> | undefined
  let announcement = ''
  let greeted = false
  /** The error of an overlay rendered into the page that cleared before the overlay attached. */
  let retired: string | undefined
  let attached = false
  let loading = false
  let pending: ErrorReport | undefined
  let badge: Badge | undefined
  let drawer: { root: HTMLElement, frame: HTMLIFrameElement, source?: string } | undefined
  const send = focusSender(() => drawer?.frame.contentWindow)
  let host: MyBadSharedSource['host']
  let hostWait = state.awaitHost
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(done, state.awaitHost)
        addEventListener('my-bad:host', done)
        function done() {
          clearTimeout(timer)
          removeEventListener('my-bad:host', done)
          hostWait = undefined
          resolve()
        }
      })
    : undefined

  target.snapshot = () => ({
    ready: !!hello.version,
    connected,
    actions: hello.actions,
    overlay,
    current,
    history,
    problems: [
      ...problems.values(),
    ].map(set => ({
      ...set,
      reports: problemReports.get(set.source),
    })),
  })
  Object.defineProperty(target, 'host', {
    get: () => host,
    set: (value: MyBadSharedSource['host']) => {
      host = value
      closeDrawer()
      render()
    },
  })

  const warnings = () => history.filter(entry => entry.kind === 'warning')
  const forward = (type: string, payload?: unknown) => target.dispatchEvent(payload === undefined
    ? new Event(type)
    : new MessageEvent(type, {
        data: JSON.stringify(payload),
      }))

  function announce(next: Peek): void {
    peek = next
    holdPeek()
    const { report, more, source } = next
    const set = source === undefined
      ? undefined
      : problems.get(source)
    announcement = `${set
      ? `${set.label ?? set.source}: `
      : ''}${report.kind === 'warning'
      ? 'Warning'
      : 'Error'}: ${report.name}: ${firstLine(report.message)}${more
      ? `, and ${more} more`
      : ''}`
  }

  function holdPeek(): void {
    clearTimeout(peekTimer)
    peekTimer = setTimeout(() => {
      if (badge && (badge.peek.matches(':hover') || badge.host.shadowRoot!.activeElement === badge.peek)) {
        return
      }
      peek = undefined
      render()
    }, PEEK_MS)
  }

  function stillOpen(next: Peek): boolean {
    const { report, source } = next
    if (source !== undefined) {
      const set = problems.get(source)
      return !!set && !!(set.errors + set.warnings) && !!problemReports.get(source)?.some(entry => entry.id === report.id)
    }
    return report.kind === 'warning'
      ? reports.has(report.id)
      : current?.id === report.id
  }

  function setHistory(next: HistoryEntry[]): void {
    history = next
    for (const id of reports.keys()) {
      if (!history.some(entry => entry.id === id)) {
        reports.delete(id)
      }
    }
  }

  /** The problem reports in full, which the channel serves only to pages on its own machine. */
  function fetchProblems(): void {
    if (withheld) {
      return
    }
    if (fetching) {
      refetch = true
      return
    }
    fetching = true
    fetch(new URL('problems', target.url))
      .then((res) => {
        withheld = res.status === 403
        return res.ok
          ? res.json() as Promise<ProblemSet[]>
          : undefined
      })
      .catch(() => undefined)
      .then((sets) => {
        fetching = false
        if (sets) {
          receiveProblems(sets)
        }
        if (refetch) {
          refetch = false
          fetchProblems()
        }
      })
  }

  function receiveProblems(fetched: ProblemSet[]): void {
    const sets = fetched.filter(set => problems.has(set.source))
    const fresh: Array<{ report: ErrorReport, source: string }> = []
    for (const set of sets) {
      const known = new Set(problemReports.get(set.source)?.map(report => report.id))
      for (const report of set.reports) {
        if (problemsKnown && !known.has(report.id)) {
          fresh.push({ report, source: set.source })
        }
      }
    }
    problemReports.clear()
    for (const set of sets) {
      problemReports.set(set.source, set.reports)
    }
    problemsKnown = true
    const first = fresh.find(entry => entry.report.kind !== 'warning') ?? fresh[0]
    if (first) {
      announce({ ...first, more: fresh.filter(entry => entry.source === first.source).length - 1 })
    }
    forward('reports')
    render()
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
    problems.clear()
    for (const set of payload.problems ?? []) {
      problems.set(set.source, set)
    }
    if (problems.size) {
      fetchProblems()
    }
    else {
      problemReports.clear()
      problemsKnown = true
    }
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
    dispatchEvent(new CustomEvent('my-bad:error:clear', {
      detail: { id },
    }))
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
        announce({ report: payload.report, more: 0 })
        mountError()
        break
      case 'error:clear':
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
          announce({ report: payload.report, more: 0 })
        }
        break
      }
      case 'problems':
        problems.set(payload.source, payload)
        fetchProblems()
        break
      case 'problems:clear':
        if (payload.source === undefined) {
          problems.clear()
          problemReports.clear()
        }
        else {
          problems.delete(payload.source)
          problemReports.delete(payload.source)
        }
        break
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
      return res.ok
        ? await res.json()
        : undefined
    }
    catch {}
  }

  async function expand(chosen?: ErrorReport): Promise<void> {
    if (target.host) {
      target.host.open({ id: (chosen ?? current ?? warnings().at(-1))?.id })
      return
    }
    const report = chosen ?? current ?? await latestWarning()
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
    const mount = () => {
      if (current && !attached && !target.host && !document.querySelector(tag)) {
        load(current)
      }
    }
    whenParsed(() => hostWait && hello.devtools
      ? void hostWait.then(mount)
      : mount())
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

  function drawerUrl(): string | undefined {
    try {
      const url = new URL('panel?embed&drawer', target.url)
      return /^https?:$/.test(url.protocol)
        ? url.href
        : undefined
    }
    catch {}
  }

  function openDrawer(focus: BadgeFocus): void {
    const panel = drawerUrl()
    if (!badge || !panel) {
      return
    }
    if (!drawer) {
      const root = document.createElement('div')
      root.className = 'mb-drawer'
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-label', 'Problems')
      const frame = document.createElement('iframe')
      frame.title = 'Problems'
      frame.src = panel
      root.append(frame)
      badge.host.shadowRoot!.append(root)
      drawer = { root, frame }
    }
    drawer.source = focus.source
    drawer.root.dataset.dock = badge.dock.dataset.dock
    send(focus)
    drawer.frame.focus()
  }

  function closeDrawer(): void {
    if (!drawer) {
      return
    }
    const { root, source } = drawer
    drawer = undefined
    root.remove()
    const pill = [
      ...badge?.problems.querySelectorAll<HTMLElement>('[data-source]') ?? [],
    ].find(entry => entry.dataset.source === source)
    const next = pill ?? badge?.button
    next?.focus()
  }

  addEventListener('message', (event) => {
    if (drawer && event.origin === location.origin && event.source === drawer.frame.contentWindow && (event.data as { type?: string } | undefined)?.type === 'my-bad:close') {
      closeDrawer()
    }
  })
  addEventListener('keydown', (event) => {
    if (drawer && event.key === 'Escape') {
      closeDrawer()
    }
  })

  function scheme(): string {
    const remembered = storage(THEME_STORAGE_KEY)
    return overlay.theme?.scheme ?? (remembered === 'light' || remembered === 'dark'
      ? remembered
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light')
  }

  function create(): Badge {
    const host = document.createElement(`${tag}-badge`)
    host.setAttribute('data-my-bad', '')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `${styles}${overlay.styles ?? ''}`
    const dock = document.createElement('div')
    dock.className = 'mb-dock'
    dock.lang = 'en'
    dock.innerHTML = '<span class="mb-problems"><span></span><span class="mb-problems-count"></span></span><button type="button" class="mb-badge"><span></span><span class="mb-badge-count"></span></button><button type="button" class="mb-peek" hidden><span class="mb-peek-inner"><span></span><span class="mb-peek-message"></span><span class="mb-peek-meta"></span></span></button>'
    const [problems, button, card] = dock.children as unknown as [HTMLElement, HTMLButtonElement, HTMLButtonElement]
    button.addEventListener('click', () => void expand())
    card.addEventListener('click', openPeek)
    const release = () => peek && holdPeek()
    card.addEventListener('pointerleave', release)
    card.addEventListener('blur', release)
    const status = document.createElement('div')
    status.className = 'mb-sr-only'
    status.setAttribute('role', 'status')
    shadow.append(style, dock, status)
    const [, count] = button.children as unknown as HTMLElement[]
    return {
      host,
      dock,
      button,
      problems,
      count: count!,
      peek: card,
      status,
    }
  }

  function openPeek(): void {
    const shown = peek
    peek = undefined
    clearTimeout(peekTimer)
    render()
    if (shown?.source === undefined) {
      void expand(shown?.report)
      return
    }
    openProblems({ id: shown.report.id, source: shown.source })
  }

  function openProblems(focus: BadgeFocus): void {
    if (target.host) {
      target.host.open(focus)
    }
    else {
      openDrawer(focus)
    }
  }

  function drawPeek(): void {
    const { dock, peek: card, host } = badge!
    if (peek === drawn) {
      return
    }
    if (peek && !drawn && document.hasFocus() && host.shadowRoot!.activeElement) {
      peek = undefined
      return
    }
    const from = drawn
    drawn = peek
    if (peek) {
      fillPeek(card, peek)
      card.hidden = false
      dock.dataset.peek = ''
      if (!from) {
        void morph(card, pillOf(peek), true)
      }
      return
    }
    if (!reducedMotion()) {
      delete dock.dataset.peek
    }
    void morph(card, pillOf(from!), false).then(() => {
      if (!drawn) {
        card.hidden = true
        delete dock.dataset.peek
      }
    })
  }

  function reducedMotion(): boolean {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function hidePeek(): void {
    peek = undefined
    drawn = undefined
    if (badge) {
      badge.peek.hidden = true
      delete badge.dock.dataset.peek
    }
  }

  function pillOf(shown: Peek): HTMLElement {
    return shown.source === undefined
      ? badge!.button
      : badge!.problems
  }

  function fillPeek(card: HTMLElement, shown: Peek): void {
    const { report, more, source } = shown
    const set = source === undefined
      ? undefined
      : problems.get(source)
    const kind = report.kind === 'warning'
      ? 'warning'
      : 'error'
    const frame = reportLocation(report)
    const [icon, message, meta] = card.firstElementChild!.children as unknown as HTMLElement[]
    card.dataset.kind = kind
    icon!.outerHTML = ICONS[kind]
    message!.textContent = `${report.name}: ${firstLine(report.message)}`
    meta!.textContent = [
      set && (set.group
        ? `${set.group} · ${set.label ?? set.source}`
        : set.label ?? set.source),
      frame?.file && `${displayPath(frame, overlay.cwd)}${frame.line === undefined
        ? ''
        : `:${frame.line}`}`,
      more && `and ${more} more`,
    ].filter(Boolean).join(' · ')
  }

  function morph(card: HTMLElement, pill: HTMLElement, open: boolean): Promise<void> {
    for (const animation of card.getAnimations({ subtree: true })) {
      animation.cancel()
    }
    const inner = card.firstElementChild as HTMLElement
    const to = card.getBoundingClientRect()
    const from = pill.getBoundingClientRect()
    const reduced = reducedMotion() || !from.width
    const side = badge!.dock.dataset.dock ?? ''
    const pillShape = {
      width: `${from.width}px`,
      height: `${from.height}px`,
      borderRadius: `${from.height / 2}px`,
      transform: `translate(${side.endsWith('left')
        ? from.left - to.left
        : from.right - to.right}px, ${side.startsWith('top')
        ? from.top - to.top
        : from.bottom - to.bottom}px)`,
    }
    const cardShape = {
      width: `${to.width}px`,
      height: `${to.height}px`,
      borderRadius: getComputedStyle(card).borderRadius,
      transform: 'none',
    }
    const frames: Keyframe[] = reduced
      ? [
          {
            opacity: open ? 0 : 1,
          },
          {
            opacity: open ? 1 : 0,
          },
        ]
      : open
        ? [
            { ...pillShape, opacity: 0 },
            { opacity: 1, offset: 0.3 },
            { ...cardShape, opacity: 1 },
          ]
        : [
            { ...cardShape, opacity: 1 },
            { opacity: 1, offset: 0.6 },
            { ...pillShape, opacity: 0 },
          ]
    const timing: KeyframeAnimationOptions = {
      duration: reduced ? 150 : 240,
      delay: reduced && open
        ? 150
        : 0,
      easing: 'cubic-bezier(.2, 0, 0, 1)',
      fill: 'backwards',
    }
    if (!reduced) {
      inner.style.width = `${inner.offsetWidth}px`
      const text = open
        ? [
            { opacity: 0 },
            { opacity: 1, offset: 0.5 },
            { opacity: 1 },
          ]
        : [
            { opacity: 1 },
            { opacity: 0, offset: 0.4 },
            { opacity: 0 },
          ]
      for (const line of [...inner.children].slice(1)) {
        line.animate(text, timing)
      }
    }
    return card.animate(frames, timing).finished.then(() => {}, () => {}).then(() => {
      if (!card.getAnimations().length) {
        inner.style.width = ''
      }
    })
  }

  /** A host whose overlay has not been built yet counts as shown, since its script is about to build it. */
  function overlayShown(): boolean {
    const view = document.querySelector(tag)
    const dialog = view?.shadowRoot?.querySelector('[data-overlay]')
    return !!view && (!dialog || !dialog.hasAttribute('data-hidden'))
  }

  function renderProblems(pill: HTMLElement, listed: ProblemSummary[]): void {
    const kind = listed.some(set => set.errors || failed(set))
      ? 'error'
      : 'warning'
    const checking = [
      ...problems.values(),
    ].some(set => set.status === 'checking')
    pill.dataset.kind = kind
    pill.firstElementChild!.outerHTML = ICONS[checking
      ? 'checking'
      : kind]
    const entries = groupProblems(listed).map((sets) => {
      const broken = sets.filter(failed).length
      const count = sets.reduce((total, set) => failed(set)
        ? total
        : total + set.errors + set.warnings, 0)
      const focus = { source: sets[0]!.source }
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.dataset.source = focus.source
      entry.addEventListener('click', () => openProblems(focus))
      entry.textContent = `${sets[0]!.group ?? sets[0]!.label ?? sets[0]!.source} ${broken === sets.length
        ? 'failed'
        : broken
          ? `${count}, ${broken} failed`
          : count}`
      entry.title = `${sets.map(set => `${set.group
        ? `${set.group} `
        : ''}${set.label ?? set.source}: ${failed(set)
        ? `failed${set.error
          ? `: ${set.error}`
          : ''}`
        : counts(set.errors, set.warnings)}${set.status === 'checking'
        ? ' (checking)'
        : ''}`).join('; ')}`
      return entry
    })
    pill.lastElementChild!.replaceChildren(...entries.flatMap((entry, index) => index
      ? [' · ', entry]
      : [entry]))
  }

  function listedProblems(): ProblemSummary[] {
    return [
      ...problems.values(),
    ].filter(set => set.errors + set.warnings || failed(set))
  }

  function groupProblems(listed: ProblemSummary[]): ProblemSummary[][] {
    const groups = new Map<string, ProblemSummary[]>()
    for (const set of listed) {
      const key = set.group ?? `\0${set.source}`
      groups.set(key, [
        ...groups.get(key) ?? [],
        set,
      ])
    }
    return [
      ...groups.values(),
    ]
  }

  function render(): void {
    const count = warnings().length
    const shown = overlayShown()
    const listed = listedProblems()
    const showErrors = !!(current || count) && !shown
    const showProblems = !!listed.length && !shown
    if (!(showErrors || showProblems) || !document.body) {
      announcement = ''
      hidePeek()
      if (badge) {
        badge.dock.hidden = true
      }
      return
    }
    badge ??= create()
    if (!badge.host.isConnected) {
      document.body.append(badge.host)
    }
    const { button, dock } = badge
    dock.hidden = false
    dock.dataset.dock = storage('my-bad:overlay:dock') ?? overlay.dock ?? 'bottom-right'
    badge.problems.hidden = !showProblems
    if (showProblems) {
      renderProblems(badge.problems, listed)
    }
    badge.host.setAttribute('data-theme', scheme())
    button.hidden = !showErrors
    if (showErrors) {
      const kind = current ? 'error' : 'warning'
      const summary = counts(current ? 1 : 0, count)
      button.dataset.kind = kind
      button.firstElementChild!.outerHTML = ICONS[kind]
      badge.count.textContent = summary
      button.title = `Show ${summary}`
    }
    if (peek && !stillOpen(peek)) {
      peek = undefined
    }
    drawPeek()
    if (announcement) {
      const { status } = badge
      const text = announcement
      announcement = ''
      setTimeout(() => (status.textContent = text), 50)
    }
  }

  document.addEventListener('visibilitychange', () => document.hidden
    ? disconnect()
    : connect())
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
if (state?.overlay.channel && typeof EventSource !== 'undefined' && (state.hosted || !window.__MY_BAD_CLIENT__) && !window.__MY_BAD_SOURCE__) {
  start(state)
  dispatchEvent(new Event('my-bad:badge'))
}

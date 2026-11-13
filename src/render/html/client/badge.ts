import type { ChannelEvent, ProblemSet, ProblemSummary } from '../../../channel/protocol'
import type { ErrorReport, HistoryEntry } from '../../../types'
import type { BadgeFocus, BadgeState, PageState } from '../state'
import styles from 'virtual:my-bad-badge-styles'
import { plainText } from '../../../report/code'
import { displayPath } from '../../../report/path'
import { escapeHtml, inlineHtml } from '../escape'
import { THEME_STORAGE_KEY } from '../state'
import { firstLine, plural, repeatsLabel, reportLocation } from '../summary'
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
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01"/></svg>',
  failed: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
}

const LEVELS = ['error', 'warning', 'failed'] as const

const DOT = '<svg class="mb-dot" viewBox="0 0 6 6" aria-hidden="true"><circle cx="3" cy="3" r="3"/></svg>'

/** How long a new report is shown in full before the badge collapses back. */
const PEEK_MS = 6000

/** How long the badge says all is clear before it steps away. */
const CLEAR_MS = 1400

const EASE = 'cubic-bezier(.32, .72, 0, 1)'

interface Badge {
  host: HTMLElement
  dock: HTMLElement
  button: HTMLButtonElement
  lamp: HTMLElement
  list: HTMLElement
  peek: HTMLButtonElement
  status: HTMLElement
}

/** Somewhere the badge can take you: the open error and warnings of the page, or a problem set, or a group of them. */
type Place = { page: true } | { page?: undefined, sets: ProblemSummary[] }

interface Totals {
  error: number
  warning: number
  failed: number
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

function start(state: BadgeState, nonce: string | undefined): void {
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
  let listOpen = false
  /** Whether the badge last showed anything, so the moment everything clears can be told apart from a quiet page. */
  let showing = false
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  let shownPlaces: Place[] = []
  let shownTotals: Totals = { error: 0, warning: 0, failed: 0 }
  /** The totals last shown, so a new error can make the light ping. */
  let previous: Totals | undefined
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
      : 'Error'}: ${set && repeatsLabel(report.name, set.label ?? set.source)
      ? ''
      : `${report.name}: `}${plainText(firstLine(report.message), report.codeSpans)}${more
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
        if (problemsKnown && !known.has(report.id) && report.kind !== 'info') {
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
    if (nonce) {
      json.nonce = script.nonce = nonce
    }
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
    const { root } = drawer
    drawer = undefined
    root.remove()
    badge?.button.focus()
  }

  addEventListener('message', (event) => {
    if (drawer && event.origin === location.origin && event.source === drawer.frame.contentWindow && (event.data as { type?: string } | undefined)?.type === 'my-bad:close') {
      closeDrawer()
    }
  })
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return
    }
    if (drawer) {
      closeDrawer()
    }
    else if (listOpen) {
      toggleList(false)
    }
  })
  addEventListener('pointerdown', (event) => {
    if (listOpen && badge && !event.composedPath().includes(badge.dock)) {
      toggleList(false)
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
    if (nonce) {
      style.nonce = nonce
    }
    const dock = document.createElement('div')
    dock.className = 'mb-dock'
    dock.lang = 'en'
    const slots = LEVELS.map(level => `<span class="mb-slot" data-level="${level}"><span><span class="mb-fold mb-slot-icon"><span>${ICONS[level]}</span></span><span class="mb-slot-num"></span><span class="mb-fold mb-slot-word"><span>${level === 'failed'
      ? ' failed'
      : ''}</span></span></span></span>`).join('')
    dock.innerHTML = `<div class="mb-list" id="mb-list" role="group" aria-label="Problems" hidden><div class="mb-list-inner"></div></div><button type="button" class="mb-peek" hidden><span class="mb-peek-inner">${DOT}<span class="mb-peek-message"></span><span class="mb-peek-hint"></span><span class="mb-peek-meta"></span></span></button><button type="button" class="mb-badge"><span class="mb-badge-title" aria-hidden="true">Problems</span><span class="mb-lamp"></span><span class="mb-sr-only"></span>${slots}<span class="mb-slot" data-level="clear"><span>All clear</span></span><span class="mb-sr-only"></span></button>`
    const [list, card, button] = dock.children as unknown as [HTMLElement, HTMLButtonElement, HTMLButtonElement]
    button.addEventListener('click', event => select(event.detail === 0))
    card.addEventListener('click', openPeek)
    const release = () => peek && holdPeek()
    card.addEventListener('pointerleave', release)
    card.addEventListener('blur', release)
    list.addEventListener('keydown', event => moveInList(event))
    const status = document.createElement('div')
    status.className = 'mb-sr-only'
    status.setAttribute('role', 'status')
    shadow.append(style, dock, status)
    return {
      host,
      dock,
      button,
      lamp: button.querySelector('.mb-lamp')!,
      list,
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
    if (peek && !drawn && (listOpen || (document.hasFocus() && host.shadowRoot!.activeElement))) {
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
        void morph(card, badge!.button, true)
      }
      return
    }
    if (!reducedMotion()) {
      delete dock.dataset.peek
    }
    void morph(card, badge!.button, false).then(() => {
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

  function fillPeek(card: HTMLElement, shown: Peek): void {
    const { report, more, source } = shown
    const set = source === undefined
      ? undefined
      : problems.get(source)
    const kind = report.kind === 'warning'
      ? 'warning'
      : 'error'
    const frame = reportLocation(report)
    const [, message, hint, meta] = card.firstElementChild!.children as unknown as HTMLElement[]
    card.dataset.kind = kind
    message!.innerHTML = `${set && repeatsLabel(report.name, set.label ?? set.source)
      ? ''
      : `${escapeHtml(report.name)}: `}${inlineHtml(firstLine(report.message), report.codeSpans)}`
    hint!.innerHTML = inlineHtml(report.hint ?? '', report.codeSpans)
    hint!.hidden = !report.hint
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
      padding: '0px',
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
      padding: getComputedStyle(card).padding,
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
      for (const line of [...inner.children].slice(card === badge!.peek
        ? 1
        : 0)) {
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

  /** Every place with something to show, the page first. */
  function placesOf(showPage: boolean, listed: ProblemSummary[]): Place[] {
    return [
      ...showPage
        ? [
            { page: true } as const,
          ]
        : [],
      ...groupProblems(listed).map(sets => ({ sets })),
    ]
  }

  function totalsOf(showPage: boolean, listed: ProblemSummary[]): Totals {
    const sum: Totals = {
      error: showPage && current
        ? 1
        : 0,
      warning: showPage
        ? warnings().length
        : 0,
      failed: 0,
    }
    for (const set of listed) {
      if (failed(set)) {
        sum.failed++
      }
      else {
        sum.error += set.errors
        sum.warning += set.warnings
      }
    }
    return sum
  }

  function describe(sum: Totals): string {
    return [
      counts(sum.error, sum.warning),
      sum.failed && plural(sum.failed, 'failed check'),
    ].filter(Boolean).join(', ')
  }

  /** The pill takes you straight to the only place with problems, and lists them when there is a choice. */
  function select(byKeyboard: boolean): void {
    if (listOpen || shownPlaces.length > 1) {
      toggleList(!listOpen, byKeyboard)
      return
    }
    const [place] = shownPlaces
    if (place) {
      peek = undefined
      clearTimeout(peekTimer)
      render()
      go(place)
    }
  }

  function go(place: Place): void {
    if (place.page) {
      void expand()
    }
    else {
      openProblems({ source: place.sets[0]!.source })
    }
  }

  function toggleList(open: boolean, byKeyboard = false): void {
    if (!badge || open === listOpen) {
      return
    }
    const { dock, list, button, host } = badge
    listOpen = open
    button.setAttribute('aria-expanded', String(open))
    if (open) {
      clearTimeout(peekTimer)
      hidePeek()
      fillList()
      list.hidden = false
      dock.dataset.open = ''
      void morph(list, button, true)
      if (byKeyboard) {
        list.querySelector<HTMLElement>('.mb-row')?.focus()
      }
      return
    }
    const active = host.shadowRoot!.activeElement
    delete dock.dataset.open
    if (active && list.contains(active)) {
      button.focus()
    }
    void morph(list, button, false).then(() => {
      if (!listOpen) {
        list.hidden = true
      }
    })
  }

  function moveInList(event: KeyboardEvent): void {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!badge || !keys.includes(event.key)) {
      return
    }
    const rows = [
      ...badge.list.querySelectorAll<HTMLElement>('.mb-row'),
    ]
    const at = rows.indexOf(badge.host.shadowRoot!.activeElement as HTMLElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : (at + (event.key === 'ArrowDown'
            ? 1
            : -1) + rows.length) % rows.length
    event.preventDefault()
    rows[next]?.focus()
  }

  function dot(kind: string): Element {
    const holder = document.createElement('span')
    holder.innerHTML = DOT
    const el = holder.firstElementChild!
    el.setAttribute('data-kind', kind)
    return el
  }

  function span(className: string, text = ''): HTMLElement {
    const el = document.createElement('span')
    el.className = className
    el.textContent = text
    return el
  }

  /** The count columns of the list match the counts the open pill shows, so each number sits under its level. */
  function fillList(): void {
    const { list, host } = badge!
    const columns = LEVELS.filter(level => shownTotals[level])
    list.style.setProperty('--mb-cols', `6px minmax(0, 1fr)${columns.map(level => level === 'failed'
      ? ' var(--mb-col-failed)'
      : ' var(--mb-col)').join('')}`)
    const rows: HTMLElement[] = []
    shownPlaces.forEach((place, index) => {
      if (index === 1 && shownPlaces[0]!.page) {
        const section = document.createElement('div')
        section.className = 'mb-list-section'
        section.textContent = 'Checks'
        rows.push(section)
      }
      rows.push(listRow(place, columns))
    })
    const focused = (host.shadowRoot!.activeElement as HTMLElement | null)?.dataset.place
    list.firstElementChild!.replaceChildren(...rows)
    if (focused) {
      rows.find(row => row.dataset.place === focused)?.focus()
    }
  }

  function listRow(place: Place, columns: Array<typeof LEVELS[number]>): HTMLElement {
    const entry = document.createElement('button')
    entry.type = 'button'
    entry.className = 'mb-row'
    const cells: Totals = { error: 0, warning: 0, failed: 0 }
    let name: string
    let detail = ''
    let checking = false
    let broken = false
    if (place.page) {
      name = 'This page'
      cells.error = current ? 1 : 0
      cells.warning = warnings().length
      detail = current
        ? `${current.name}: ${plainText(firstLine(current.message), current.codeSpans)}`
        : ''
      entry.dataset.place = 'page'
    }
    else {
      const { sets } = place
      const first = sets[0]!
      const failures = sets.filter(failed)
      broken = failures.length === sets.length
      checking = sets.some(set => set.status === 'checking')
      for (const set of sets) {
        if (!failed(set)) {
          cells.error += set.errors
          cells.warning += set.warnings
        }
      }
      cells.failed = broken ? 0 : failures.length
      name = first.group ?? first.label ?? first.source
      detail = broken
        ? failures.map(set => set.error).filter(Boolean).join('; ')
        : checking
          ? 'Checking…'
          : first.group
            ? sets.map(set => set.label ?? set.source).join(', ')
            : ''
      entry.title = sets.map(set => `${set.group
        ? `${set.group} `
        : ''}${set.label ?? set.source}: ${failed(set)
        ? `failed${set.error
          ? `: ${set.error}`
          : ''}`
        : counts(set.errors, set.warnings)}${set.status === 'checking'
        ? ' (checking)'
        : ''}`).join('; ')
      entry.dataset.place = entry.dataset.source = first.source
    }
    const level = broken || cells.error
      ? 'error'
      : cells.warning
        ? 'warning'
        : 'idle'
    // the row is named by what it shows, like "TypeScript: 2 errors, 1 warning", with the joining words for screen readers only
    const said = (text: string) => span('mb-sr-only', text)
    const values = columns.filter(column => cells[column])
    const title = span('mb-row-name')
    title.append(span('', name), said(': '))
    if (detail) {
      const line = span('mb-row-detail', detail)
      if (broken) {
        line.dataset.wrap = ''
      }
      if (checking && !broken) {
        line.prepend(span('mb-spinner'))
      }
      if (broken || values.length) {
        line.append(said(', '))
      }
      title.append(line)
    }
    entry.append(dot(level), title)
    if (broken) {
      entry.append(span('mb-row-failed', 'Failed'))
    }
    else {
      for (const column of columns) {
        const value = cells[column]
        const cell = span('mb-row-count')
        cell.dataset.level = column === 'failed'
          ? 'error'
          : column
        if (value) {
          cell.append(values.indexOf(column)
            ? said(', ')
            : '', span('', String(value)), said(column === 'failed'
            ? ' failed'
            : ` ${value === 1
              ? column
              : `${column}s`}`))
        }
        entry.append(cell)
      }
    }
    entry.addEventListener('click', () => {
      toggleList(false)
      go(place)
    })
    return entry
  }

  /** A count rolls to its new value, up when it grows and down when it shrinks. */
  function setCount(el: HTMLElement, value: number): void {
    const text = String(value)
    if (el.dataset.value === text) {
      return
    }
    const from = Number(el.dataset.value)
    el.dataset.value = text
    const old = el.lastElementChild
    old?.setAttribute('aria-hidden', 'true')
    el.append(span('', text))
    if (!old) {
      return
    }
    if (reducedMotion() || !badge!.host.isConnected) {
      old.remove()
      return
    }
    const shift = value > from
      ? 70
      : -70
    const timing = { duration: 260, easing: EASE }
    old.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translateY(${-shift}%)`, opacity: 0 },
    ], timing).finished.then(() => old.remove(), () => old.remove())
    el.lastElementChild!.animate([
      { transform: `translateY(${shift}%)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], timing)
  }

  function drawSummary(sum: Totals, clear: boolean): void {
    for (const slot of badge!.button.querySelectorAll<HTMLElement>('.mb-slot')) {
      const level = slot.dataset.level as typeof LEVELS[number] | 'clear'
      const value = level === 'clear'
        ? Number(clear)
        : sum[level]
      slot.toggleAttribute('data-on', !!value)
      slot.setAttribute('aria-hidden', String(!value))
      if (level === 'clear' || !value) {
        continue
      }
      setCount(slot.querySelector('.mb-slot-num')!, value)
      if (level !== 'failed') {
        slot.querySelector('.mb-slot-word > span')!.textContent = ` ${value === 1
          ? level
          : `${level}s`}`
      }
    }
  }

  /** The pill is named by what it shows, with words around the counts for screen readers only. */
  function speak(before: string, after: string): void {
    const [intro, outro] = badge!.button.querySelectorAll<HTMLElement>(':scope > .mb-sr-only')
    intro!.textContent = before
    outro!.textContent = after
  }

  /** Everything the badge showed is fixed: it says so for a moment, then steps away. */
  function sayClear(): void {
    const { dock, button, lamp, status } = badge!
    showing = false
    previous = undefined
    dock.dataset.clear = ''
    drawSummary({ error: 0, warning: 0, failed: 0 }, true)
    lamp.dataset.level = 'ok'
    delete lamp.dataset.checking
    button.removeAttribute('aria-expanded')
    button.removeAttribute('aria-controls')
    button.title = 'All clear'
    speak('', '')
    setTimeout(() => (status.textContent = 'All clear'), 50)
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => {
      const done = () => {
        if (dock.dataset.clear !== undefined) {
          dock.hidden = true
          delete dock.dataset.clear
        }
      }
      if (reducedMotion()) {
        done()
        return
      }
      dock.animate([
        { opacity: 1 },
        { opacity: 0, transform: 'translateY(4px) scale(.97)' },
      ], { duration: 200, easing: EASE }).finished.then(done, done)
    }, CLEAR_MS)
  }

  function render(): void {
    const shown = overlayShown()
    const listed = listedProblems()
    const showPage = !!(current || warnings().length) && !shown
    const showProblems = !!listed.length && !shown
    if (!(showPage || showProblems) || !document.body) {
      shownPlaces = []
      announcement = ''
      hidePeek()
      toggleList(false)
      if (badge && !shown && document.body && (showing || badge.dock.dataset.clear !== undefined)) {
        if (badge.dock.dataset.clear === undefined) {
          sayClear()
        }
        return
      }
      showing = false
      previous = undefined
      clearTimeout(clearTimer)
      if (badge) {
        badge.dock.hidden = true
        delete badge.dock.dataset.clear
      }
      return
    }
    badge ??= create()
    if (!badge.host.isConnected) {
      document.body.append(badge.host)
    }
    const { button, dock, lamp } = badge
    clearTimeout(clearTimer)
    delete dock.dataset.clear
    for (const animation of dock.getAnimations()) {
      animation.cancel()
    }
    showing = true
    dock.hidden = false
    dock.dataset.dock = storage('my-bad:overlay:dock') ?? overlay.dock ?? 'bottom-right'
    badge.host.setAttribute('data-theme', scheme())
    const sets = showProblems
      ? listed
      : []
    shownPlaces = placesOf(showPage, sets)
    shownTotals = totalsOf(showPage, sets)
    drawSummary(shownTotals, false)
    const kind = shownTotals.error || shownTotals.failed
      ? 'error'
      : 'warning'
    const checking = [
      ...problems.values(),
    ].some(set => set.status === 'checking')
    button.dataset.kind = lamp.dataset.level = kind
    lamp.toggleAttribute('data-checking', checking)
    const worse = (sum: Totals) => sum.error + sum.failed
    if (previous && worse(shownTotals) > worse(previous) && !reducedMotion()) {
      lamp.animate([
        { boxShadow: '0 0 0 0 currentColor' },
        { boxShadow: '0 0 0 7px transparent' },
      ], { duration: 900, easing: EASE })
    }
    previous = shownTotals
    const summary = `${describe(shownTotals)}${checking ? ', checking' : ''}`
    const [only] = shownPlaces
    const label = shownPlaces.length > 1
      ? `Problems: ${summary}`
      : only?.page
        ? `Show ${summary}`
        : `${only!.sets[0]!.group ?? only!.sets[0]!.label ?? only!.sets[0]!.source}: ${summary}`
    button.title = label
    speak(shownPlaces.length > 1
      ? 'Problems: '
      : only?.page
        ? 'Show '
        : `${only!.sets[0]!.group ?? only!.sets[0]!.label ?? only!.sets[0]!.source}: `, checking
      ? ', checking'
      : '')
    if (shownPlaces.length > 1) {
      button.setAttribute('aria-expanded', String(listOpen))
      button.setAttribute('aria-controls', 'mb-list')
    }
    else {
      toggleList(false)
      button.removeAttribute('aria-expanded')
      button.removeAttribute('aria-controls')
    }
    if (listOpen) {
      fillList()
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

const script = document.currentScript as HTMLScriptElement | null
const state = readJson<BadgeState>(script?.previousElementSibling)
if (state?.overlay.channel && typeof EventSource !== 'undefined' && (state.hosted || !window.__MY_BAD_CLIENT__) && !window.__MY_BAD_SOURCE__) {
  start(state, script?.nonce)
  dispatchEvent(new Event('my-bad:badge'))
}

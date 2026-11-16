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

const DOT = '<svg class="mb-dot" viewBox="0 0 6 6" aria-hidden="true"><circle cx="3" cy="3" r="3"/></svg>'

/** How long a new report is shown in full before the badge collapses back. */
const PEEK_MS = 6000

/** How long the badge says all is clear before it steps away. */
const CLEAR_MS = 1400

const EASE = 'cubic-bezier(.32, .72, 0, 1)'

interface Badge {
  host: HTMLElement
  dock: HTMLElement
  /** The pill: a group of one button for each count. */
  pill: HTMLElement
  lamp: HTMLElement
  peek: HTMLButtonElement
  status: HTMLElement
}

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
  /** Whether the badge last showed anything, so the moment everything clears can be told apart from a quiet page. */
  let showing = false
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  /** The problem sets the pill counts. */
  let shownSets: ProblemSummary[] = []
  /** The totals last shown, so a new error can make the light ping. */
  let previous: Totals | undefined
  /** The count that opened the drawer, which gets the focus back when it closes. */
  let opener: HTMLElement | undefined
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
    ;(opener?.isConnected && !opener.closest('[inert]')
      ? opener
      : badge?.pill.querySelector<HTMLElement>('.mb-slot[data-on] .mb-count'))?.focus()
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
    // Vite DevTools hides its panel on a press anywhere outside it. Hosted there, the badge is part of DevTools, so a
    // press on it must not count as outside, or the dock flashes shut and open on every click
    for (const type of ['pointerdown', 'mousedown']) {
      host.addEventListener(type, event => target.host && event.stopPropagation())
    }
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `${styles}${overlay.styles ?? ''}`
    if (nonce) {
      style.nonce = nonce
    }
    const dock = document.createElement('div')
    dock.className = 'mb-dock'
    dock.lang = 'en'
    const slots = (['error', 'warning', 'failed'] as const).map(level => `<span class="mb-slot" data-level="${level}" inert><button type="button" class="mb-count"><span class="mb-count-num"></span><span class="mb-count-word"></span></button></span>`).join('')
    dock.innerHTML = `<button type="button" class="mb-peek" hidden><span class="mb-peek-inner">${DOT}<span class="mb-peek-message"></span><span class="mb-peek-hint"></span><span class="mb-peek-meta"></span></span></button><div class="mb-badge" role="group" aria-label="Problems"><span class="mb-lamp"></span>${slots}<span class="mb-slot" data-level="clear" inert><span class="mb-count">All clear</span></span></div>`
    const [card, pill] = dock.children as unknown as [HTMLButtonElement, HTMLElement]
    pill.addEventListener('click', (event) => {
      const count = (event.target as Element).closest<HTMLElement>('button.mb-count')
      const level = count?.parentElement?.dataset.level
      if (!count || !level) {
        return
      }
      opener = count
      if (level === 'failed') {
        openFailed()
      }
      else {
        openLevel(level as 'error' | 'warning')
      }
    })
    card.addEventListener('click', openPeek)
    const release = () => peek && holdPeek()
    card.addEventListener('pointerleave', release)
    card.addEventListener('blur', release)
    const status = document.createElement('div')
    status.className = 'mb-sr-only'
    status.setAttribute('role', 'status')
    shadow.append(style, dock, status)
    return {
      host,
      dock,
      pill,
      lamp: pill.querySelector('.mb-lamp')!,
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
        void morph(card, badge!.pill, true)
      }
      return
    }
    if (!reducedMotion()) {
      delete dock.dataset.peek
    }
    void morph(card, badge!.pill, false).then(() => {
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

  /** Where an element ends up once its running animations finish, such as a count easing to a new width. */
  function settled(el: HTMLElement): DOMRect {
    const running = el.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running')
    const times = running.map(animation => animation.currentTime)
    for (const animation of running) {
      const { delay = 0, duration } = animation.effect!.getTiming()
      animation.currentTime = Number(delay) + Number(duration)
    }
    const rect = el.getBoundingClientRect()
    running.forEach((animation, index) => (animation.currentTime = times[index]!))
    return rect
  }

  function morph(card: HTMLElement, pill: HTMLElement, open: boolean): Promise<void> {
    for (const animation of card.getAnimations({ subtree: true })) {
      animation.cancel()
    }
    const inner = card.firstElementChild as HTMLElement
    const to = card.getBoundingClientRect()
    const from = settled(pill)
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
      // the card grows out of the pill and folds back into it at full opacity: it has the pill's colour, so it never
      // shows as a grey, half-faded slab over the page
      : open
        ? [
            pillShape,
            cardShape,
          ]
        : [
            cardShape,
            pillShape,
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
      // the text waits until the card has mostly grown, so it never overlaps the pill, and leaves first
      const text = open
        ? [
            { opacity: 0 },
            { opacity: 0, offset: 0.55 },
            { opacity: 1 },
          ]
        : [
            { opacity: 1 },
            { opacity: 0, offset: 0.3 },
            { opacity: 0 },
          ]
      for (const line of inner.children) {
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

  /** The check that could not run is named when it is the only one, since it is a broken tool, not a problem in the code. */
  function failedLabel(count: number): string {
    const broken = shownSets.filter(failed)
    return count === 1 && broken.length === 1
      ? `${broken[0]!.group ?? broken[0]!.label ?? broken[0]!.source} failed`
      : `${count} checks failed`
  }

  function describe(sum: Totals): string {
    return [
      counts(sum.error, sum.warning),
      sum.failed && failedLabel(sum.failed),
    ].filter(Boolean).join(', ')
  }

  function settle(): void {
    peek = undefined
    clearTimeout(peekTimer)
    render()
  }

  /**
   * A count opens the problems of its level, filtered as its tab in the list would be, on the first of them. While the
   * page is all there is, it opens the page's error or warnings in the overlay, as there is nothing to filter.
   */
  function openLevel(level: 'error' | 'warning'): void {
    settle()
    if (!shownSets.length) {
      void (level === 'error' && current
        ? expand(current)
        : latestWarning().then(report => expand(report)))
      return
    }
    const page = level === 'error'
      ? current
      : warnings().at(-1)
    const set = shownSets.find(entry => !failed(entry) && (level === 'error'
      ? entry.errors
      : entry.warnings))
    openProblems(page || !set
      ? { id: page?.id, query: `is:${level}` }
      : { source: set.source, query: `is:${level}` })
  }

  /** A check that could not run opens on its reason. It stands above the list in any filter, so the filter is kept. */
  function openFailed(): void {
    const set = shownSets.find(failed)
    if (set) {
      settle()
      openProblems({ source: set.source })
    }
  }

  function span(className: string, text = ''): HTMLElement {
    const el = document.createElement('span')
    el.className = className
    el.textContent = text
    return el
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
    const before = el.getBoundingClientRect().width
    el.append(span('', text))
    if (!old) {
      return
    }
    if (reducedMotion() || !badge!.host.isConnected) {
      old.remove()
      return
    }
    // the outgoing number leaves the layout as it rolls away, so the cell is the new number's width from the start,
    // and eases there from the old one's: the pill never jumps, and what it settles to is known straight away
    old.classList.add('mb-count-out')
    const after = el.getBoundingClientRect().width
    if (before !== after) {
      el.animate([
        { width: `${before}px` },
        { width: `${after}px` },
      ], { duration: 260, easing: EASE })
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
    for (const slot of badge!.pill.querySelectorAll<HTMLElement>('.mb-slot')) {
      const level = slot.dataset.level as keyof Totals | 'clear'
      const value = level === 'clear'
        ? Number(clear)
        : sum[level]
      slot.toggleAttribute('data-on', !!value)
      slot.inert = !value
      if (level === 'clear' || !value) {
        continue
      }
      setCount(slot.querySelector('.mb-count-num')!, value)
      const named = level === 'failed' && value === 1 && shownSets.filter(failed).length === 1
      slot.toggleAttribute('data-named', named)
      slot.querySelector('.mb-count-word')!.textContent = level === 'failed'
        ? named
          ? failedLabel(1)
          : ' checks failed'
        : ` ${value === 1
          ? level
          : `${level}s`}`
    }
  }

  /** Everything the badge showed is fixed: it says so for a moment, then steps away. */
  function sayClear(): void {
    const { dock, pill, lamp, status } = badge!
    showing = false
    previous = undefined
    dock.dataset.clear = ''
    drawSummary({ error: 0, warning: 0, failed: 0 }, true)
    lamp.dataset.level = 'ok'
    delete lamp.dataset.checking
    pill.title = 'All clear'
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
      shownSets = []
      announcement = ''
      hidePeek()
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
    const { pill, dock, lamp } = badge
    clearTimeout(clearTimer)
    delete dock.dataset.clear
    for (const animation of dock.getAnimations()) {
      animation.cancel()
    }
    showing = true
    dock.hidden = false
    dock.dataset.dock = storage('my-bad:overlay:dock') ?? overlay.dock ?? 'bottom-right'
    badge.host.setAttribute('data-theme', scheme())
    shownSets = showProblems
      ? listed
      : []
    const totals = totalsOf(showPage, shownSets)
    drawSummary(totals, false)
    const kind = totals.error || totals.failed
      ? 'error'
      : 'warning'
    const checking = [
      ...problems.values(),
    ].some(set => set.status === 'checking')
    pill.dataset.kind = lamp.dataset.level = kind
    lamp.toggleAttribute('data-checking', checking)
    const worse = (sum: Totals) => sum.error + sum.failed
    if (previous && worse(totals) > worse(previous) && !reducedMotion()) {
      lamp.animate([
        { boxShadow: '0 0 0 0 currentColor' },
        { boxShadow: '0 0 0 7px transparent' },
      ], { duration: 900, easing: EASE })
    }
    previous = totals
    pill.title = `Problems: ${describe(totals)}${checking
      ? ', checking'
      : ''}`
    pill.setAttribute('aria-label', checking
      ? 'Problems, checking'
      : 'Problems')
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

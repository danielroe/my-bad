import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorReport, HistoryEntry } from '../types'
import type { BuildProgress, ChannelEvent, LogEntry, ReportRequest } from './protocol'
import type { ClientScope } from './scope'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { json } from 'node:stream/consumers'
import { ASSET_FILES, assetHash } from '../render/html/assets'
import { openInEditor } from './open'
import { isTrustedFetchRequest, isTrustedNodeRequest } from './origin'
import { toHistoryEntry } from './protocol'
import { concernsClient, scopeFromQuery } from './scope'

export { openInEditor } from './open'

export type { BuildProgress, ChannelEvent, LogEntry, LogLevel, ReportRequest } from './protocol'
export { toHistoryEntry } from './protocol'

export interface OpenRequest {
  file: string
  line?: number
  column?: number
}

export type Sink = (event: ChannelEvent) => void | Promise<void>

export interface CallerOptions {
  /**
   * Whether the caller may see reports for requests other than its own, and
   * use privileged actions such as `open`. Default `true`. An untrusted caller
   * is matched on its `/events` scope, strictly: a report naming a request id
   * needs that id, not its path.
   */
  trusted?: boolean
}

export interface ChannelOptions {
  /** Number of errors to keep. Default 20. Warnings are kept until retired, up to the 100 most recent. */
  history?: number
  /**
   * Handle "open in editor" requests. `true` uses the built-in `openInEditor`
   * (`LAUNCH_EDITOR` / `VISUAL` / `EDITOR`, falling back to the OS default app);
   * a function receives the location and may return `false` to refuse it.
   * Omit to disable the action.
   */
  open?: boolean | ((request: OpenRequest) => boolean | void | Promise<boolean | void>)
  /**
   * Directories that `open` requests are confined to. Defaults to
   * `process.cwd()`; pass `false` to accept any path, for example to open a
   * file in a dependency linked from outside the project.
   */
  root?: string | string[] | false
  /**
   * Hosts a browser may address the channel through, besides `localhost`,
   * `*.localhost` and any IP literal. Entries starting with `.` also match
   * subdomains; `true` accepts any host. Guards against DNS rebinding.
   */
  allowedHosts?: string[] | true
  /** Receives every event for logging, files, or agent integrations. */
  sink?: Sink
  /** Keepalive interval in ms. Default 15000. */
  keepalive?: number
}

export interface Channel {
  /** Node-style handler. Mount at the channel base path; routes on the path suffix. */
  handler: (req: IncomingMessage, res: ServerResponse, options?: CallerOptions) => Promise<boolean>
  /** Fetch-style handler returning `undefined` for unknown paths. */
  fetchHandler: (request: Request, options?: CallerOptions) => Promise<Response | undefined>
  /**
   * Publish an error, open until `clearError` retires it or another error replaces it. Each page shows the newest
   * open error that concerns it. Naming the request it came from (`requestId`, `METHOD /path?query`) sends it only to
   * the pages that request concerns, and replaces only earlier errors from that request; an error from no request
   * replaces every open error.
   */
  setError: (report: ErrorReport, requestId?: string, request?: string) => void
  /** Retire the open error with this id, or every open error without one. Pages showing it are told it cleared. */
  clearError: (id?: string) => void
  /** Publish a warning. It stays in the history until retired with `clearWarning`. */
  warn: (report: ErrorReport) => void
  /** Retire the warning published with this report id, or every warning without one. Pages drop it from their count and toasts. */
  clearWarning: (id?: string) => void
  /**
   * Publish a log entry. Naming the request it came from (`requestId`,
   * `METHOD /path?query`) sends it only to the pages that request concerns;
   * an unattributed entry reaches trusted callers only.
   */
  log: (entry: Omit<LogEntry, 'timestamp'> & { timestamp?: number }, requestId?: string, request?: string) => void
  /** Publish build progress. Updates carrying a `source` are resolved against the other live sources; `percent: 100` retires one. */
  progress: (progress: BuildProgress) => void
  /** The newest open error. */
  readonly current: ErrorReport | undefined
  readonly history: HistoryEntry[]
  getReport: (id: string) => ErrorReport | undefined
  /** Number of connected clients. */
  readonly clients: number
  close: () => void
}

function scopeKey(request: ReportRequest = {}): string {
  return request.requestId ? `id:${request.requestId}` : request.request ? `request:${request.request}` : ''
}

/** A source with no `percent` has unknown work left, so it ranks below any number. */
function leastAdvanced(live: Map<string, BuildProgress>): BuildProgress | undefined {
  let lowest: BuildProgress | undefined
  for (const progress of live.values()) {
    if (!lowest || (progress.percent ?? -1) < (lowest.percent ?? -1)) {
      lowest = progress
    }
  }
  return lowest
}

interface Viewer {
  scope: ClientScope
  trusted: boolean
}

interface Client extends Viewer {
  send: (chunk: string) => void
  close: () => void
}

const PRIVILEGED = new Set(['open'])
const MAX_WARNINGS = 100
const ASSET_KEYS = Object.keys(ASSET_FILES) as Array<keyof typeof ASSET_FILES>

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
}

export function createChannel(options: ChannelOptions = {}): Channel {
  const max = options.history ?? 20
  const reports = new Map<string, ErrorReport>()
  const origins = new Map<string, ReportRequest>()
  const live = new Map<string, BuildProgress>()
  /** Ids of the errors not yet cleared, oldest first. */
  const raised = new Set<string>()
  const clients = new Set<Client>()
  const actions: string[] = []
  if (options.open) {
    actions.push('open')
  }

  const keepalive = setInterval(send, options.keepalive ?? 15_000, ': ping\n\n')
  keepalive.unref?.()

  const helloFrames = new Map<string, string>()

  function concernsViewer(id: string, viewer: Viewer): boolean {
    return concernsClient(viewer.scope, origins.get(id) ?? {}, !viewer.trusted)
  }

  function history(viewer?: Viewer): HistoryEntry[] {
    const entries = [...reports.values()]
    return (viewer ? entries.filter(report => concernsViewer(report.id, viewer)) : entries).map(toHistoryEntry)
  }

  function remember(report: ErrorReport, request: ReportRequest = {}): void {
    reports.delete(report.id)
    reports.set(report.id, report)
    origins.set(report.id, request)
    const warning = report.kind === 'warning'
    const same = [...reports.values()].filter(entry => (entry.kind === 'warning') === warning)
    for (const oldest of same.slice(0, Math.max(0, same.length - (warning ? MAX_WARNINGS : max)))) {
      reports.delete(oldest.id)
      origins.delete(oldest.id)
      raised.delete(oldest.id)
    }
    helloFrames.clear()
  }

  /** The newest open error that concerns a page. */
  function shownTo(viewer: Viewer): ErrorReport | undefined {
    let shown: string | undefined
    for (const id of raised) {
      if (concernsViewer(id, viewer)) {
        shown = id
      }
    }
    return shown === undefined ? undefined : reports.get(shown)
  }

  function snapshot(): Map<Client, ErrorReport | undefined> {
    return new Map([...clients].map(client => [client, shownTo(client)]))
  }

  function sendTo(client: Client, event: ChannelEvent): void {
    try {
      client.send(encode(event))
    }
    catch {
      clients.delete(client)
    }
  }

  function errorSet(report: ErrorReport, entries: HistoryEntry[]): ChannelEvent {
    return { type: 'error:set', payload: { report, history: entries, ...origins.get(report.id) } }
  }

  /** Tell a page whose error went away, and show it the next open error that concerns it. Returns whether that sent it the history. */
  function settle(client: Client, previous: ErrorReport | undefined): boolean {
    const next = shownTo(client)
    if (!previous || next?.id === previous.id) {
      return false
    }
    sendTo(client, { type: 'error:clear', payload: { id: previous.id } })
    if (next) {
      sendTo(client, errorSet(next, history(client.trusted ? undefined : client)))
    }
    return !!next
  }

  function send(chunk: string, to: (client: Client) => boolean = () => true): void {
    for (const client of clients) {
      if (!to(client)) {
        continue
      }
      try {
        client.send(chunk)
      }
      catch {
        clients.delete(client)
      }
    }
  }

  function broadcast(event: ChannelEvent, to?: (client: Client) => boolean): void {
    send(encode(event), to)
    notify(event)
  }

  function notify(event: ChannelEvent): void {
    if (options.sink) {
      Promise.resolve(options.sink(event)).catch(() => {})
    }
  }

  function sendScoped(build: (history: HistoryEntry[]) => ChannelEvent, to: (client: Client) => boolean = () => true): void {
    const shared = encode(build(history()))
    for (const client of clients) {
      if (!to(client)) {
        continue
      }
      try {
        client.send(client.trusted ? shared : encode(build(history(client))))
      }
      catch {
        clients.delete(client)
      }
    }
  }

  /** The current error is only announced to the pages it concerns; the rest just learn it happened. */
  function hello(client: Client): string {
    const shown = shownTo(client)
    if (!client.trusted) {
      const unprivileged = actions.filter(action => !PRIVILEGED.has(action))
      return encode({ type: 'hello', payload: { version: __MY_BAD_VERSION__, actions: unprivileged, current: shown, history: history(client) } })
    }
    let frame = helloFrames.get(shown?.id ?? '')
    if (!frame) {
      frame = encode({ type: 'hello', payload: { version: __MY_BAD_VERSION__, actions, current: shown, history: history() } })
      helloFrames.set(shown?.id ?? '', frame)
    }
    return frame
  }

  /** Roots are resolved through symlinks, so a project reached by a link still matches. */
  const roots = options.root === false
    ? undefined
    : Promise.all((Array.isArray(options.root) ? options.root : [options.root ?? process.cwd()])
        .map(root => realpath(root).catch(() => resolve(root))))

  function within(target: string, against: string[]): boolean {
    return against.some((root) => {
      const path = relative(root, target)
      return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    })
  }

  async function open(request: OpenRequest): Promise<boolean> {
    if (typeof options.open === 'function') {
      return await options.open(request) !== false
    }
    if (options.open === true) {
      return openInEditor(request)
    }
    return false
  }

  function route(pathname: string): 'events' | 'open' | { history: string } | { asset: keyof typeof ASSET_FILES } | undefined {
    if (pathname.endsWith('/events')) {
      return 'events'
    }
    const asset = ASSET_KEYS.find(key => pathname.endsWith(`/${ASSET_FILES[key][0]}`))
    if (asset) {
      return { asset }
    }
    if (pathname.endsWith('/open')) {
      return 'open'
    }
    const match = /\/history\/([^/]+)$/.exec(pathname)
    if (match) {
      return { history: decodeURIComponent(match[1]!) }
    }
  }

  function encode(event: ChannelEvent): string {
    return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`
  }

  function parseOpen(body: unknown): OpenRequest | undefined {
    if (typeof body !== 'object' || body === null) {
      return
    }
    const { file, line, column } = body as Record<string, unknown>
    if (typeof file !== 'string' || !file) {
      return
    }
    return {
      file,
      line: typeof line === 'number' ? line : undefined,
      column: typeof column === 'number' ? column : undefined,
    }
  }

  async function openStatus(contentType: string | null | undefined, body: unknown): Promise<number> {
    if (!/^application\/json\b/i.test(contentType ?? '')) {
      return 415
    }
    const request = parseOpen(body)
    if (!request) {
      return 400
    }
    const target = await realpath(resolve(request.file)).catch(() => undefined)
    if (!target || !await stat(target).then(stats => stats.isFile(), () => false)) {
      return 400
    }
    if (roots && !within(target, await roots)) {
      return 403
    }
    request.file = target
    return await open(request).catch(() => false) ? 204 : 400
  }

  const trust = { allowedHosts: options.allowedHosts }

  /** 404 rather than 403, so the answer does not confirm the id exists. */
  function historyResponse(id: string, viewer: Viewer): { status: number, body: string } {
    const report = viewer.trusted || concernsViewer(id, viewer) ? reports.get(id) : undefined
    return { status: report ? 200 : 404, body: report ? JSON.stringify(report) : '{}' }
  }

  const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

  /** Only the current build's `?v=` hash is cached for good; any other URL gets the current build uncached. */
  function assetResponse(key: keyof typeof ASSET_FILES, method: string | undefined, url: URL): { status: number, headers?: Record<string, string>, body?: string } {
    if (method !== 'GET' && method !== 'HEAD') {
      return { status: 405 }
    }
    const [, type, source] = ASSET_FILES[key]
    const headers = { 'content-type': `${type}; charset=utf-8`, 'cache-control': url.searchParams.get('v') === assetHash(key) ? 'public, max-age=31536000, immutable' : 'no-cache' }
    return { status: 200, headers, body: method === 'HEAD' ? undefined : source() }
  }

  const channel: Channel = {
    async handler(req, res, caller) {
      const trusted = caller?.trusted ?? true
      const url = new URL(req.url ?? '/', 'http://localhost')
      const matched = route(url.pathname)
      if (!matched) {
        return false
      }
      if (!isTrustedNodeRequest(req, trust)) {
        res.writeHead(403).end()
        return true
      }
      if (matched === 'events') {
        res.writeHead(200, SSE_HEADERS)
        res.flushHeaders?.()
        const client: Client = {
          send: chunk => void res.write(chunk),
          close: () => res.end(),
          scope: scopeFromQuery(url.searchParams),
          trusted,
        }
        clients.add(client)
        client.send(hello(client))
        req.on('close', () => clients.delete(client))
        return true
      }
      if (matched === 'open') {
        if (!trusted) {
          res.writeHead(403).end()
          return true
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return true
        }
        const body = await json(req).catch(() => undefined)
        res.writeHead(await openStatus(req.headers['content-type'], body)).end()
        return true
      }
      if ('asset' in matched) {
        const { status, headers, body } = assetResponse(matched.asset, req.method, url)
        res.writeHead(status, headers).end(body)
        return true
      }
      const { status, body } = historyResponse(matched.history, { scope: scopeFromQuery(url.searchParams), trusted })
      res.writeHead(status, JSON_HEADERS)
      res.end(body)
      return true
    },

    async fetchHandler(request, caller) {
      const trusted = caller?.trusted ?? true
      const url = new URL(request.url)
      const matched = route(url.pathname)
      if (!matched) {
        return
      }
      if (!isTrustedFetchRequest(request, trust)) {
        return new Response(null, { status: 403 })
      }
      if (matched === 'events') {
        const encoder = new TextEncoder()
        let client: Client | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            client = {
              send: chunk => controller.enqueue(encoder.encode(chunk)),
              close: () => controller.close(),
              scope: scopeFromQuery(url.searchParams),
              trusted,
            }
            clients.add(client)
            client.send(hello(client))
          },
          cancel() {
            if (client) {
              clients.delete(client)
            }
          },
        })
        request.signal?.addEventListener('abort', () => {
          if (client) {
            clients.delete(client)
          }
        })
        return new Response(stream, { headers: SSE_HEADERS })
      }
      if (matched === 'open') {
        if (!trusted) {
          return new Response(null, { status: 403 })
        }
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        return new Response(null, { status: await openStatus(request.headers.get('content-type'), await request.json().catch(() => undefined)) })
      }
      if ('asset' in matched) {
        const { status, headers, body } = assetResponse(matched.asset, request.method, url)
        return new Response(body ?? null, { status, headers })
      }
      const { status, body } = historyResponse(matched.history, { scope: scopeFromQuery(url.searchParams), trusted })
      return new Response(body, { status, headers: JSON_HEADERS })
    },

    setError(report, requestId, request) {
      const origin: ReportRequest = { ...(requestId && { requestId }), ...(request && { request }) }
      const before = snapshot()
      remember(report, origin)
      const scope = scopeKey(origin)
      for (const id of raised) {
        if (!scope || scopeKey(origins.get(id)) === scope) {
          raised.delete(id)
        }
      }
      raised.delete(report.id)
      raised.add(report.id)
      const reaches = (client: Client) => concernsClient(client.scope, origin, !client.trusted)
      const set = (entries: HistoryEntry[]) => errorSet(report, entries)
      sendScoped(set, reaches)
      notify(set(history()))
      const settled = new Set([...clients].filter(client => !reaches(client) && settle(client, before.get(client))))
      sendScoped(entries => ({ type: 'history', payload: { history: entries } }), client => !reaches(client) && !settled.has(client))
    },
    clearError(id) {
      if (id && !raised.has(id)) {
        return
      }
      const before = snapshot()
      if (id) {
        raised.delete(id)
      }
      else {
        raised.clear()
      }
      helloFrames.clear()
      for (const client of clients) {
        settle(client, before.get(client))
      }
      notify({ type: 'error:clear', payload: { id } })
    },
    warn(report) {
      const warning = { ...report, kind: 'warning' as const }
      remember(warning)
      const event = (entries: HistoryEntry[]): ChannelEvent => ({ type: 'warning', payload: { report: warning, history: entries } })
      sendScoped(event)
      notify(event(history()))
    },
    clearWarning(id) {
      const named = id === undefined ? undefined : reports.get(id)
      if (named && named.kind !== 'warning') {
        return
      }
      for (const report of [...reports.values()]) {
        if (report.kind === 'warning' && (id === undefined || report.id === id)) {
          reports.delete(report.id)
          origins.delete(report.id)
        }
      }
      helloFrames.clear()
      const event = (entries: HistoryEntry[]): ChannelEvent => ({ type: 'warning:clear', payload: { ...(id !== undefined && { id }), history: entries } })
      sendScoped(event)
      notify(event(history()))
    },
    log(entry, requestId, request) {
      const origin: ReportRequest = { ...(requestId && { requestId }), ...(request && { request }) }
      const attributed = origin.requestId !== undefined || origin.request !== undefined
      broadcast(
        { type: 'log', payload: { timestamp: Date.now(), ...entry, ...origin } },
        client => client.trusted || (attributed && concernsClient(client.scope, origin, true)),
      )
    },
    progress(progress) {
      if (!progress.source) {
        broadcast({ type: 'build', payload: progress })
        return
      }
      if (progress.percent !== undefined && progress.percent >= 100) {
        live.delete(progress.source)
      }
      else {
        live.set(progress.source, progress)
      }
      broadcast({ type: 'build', payload: leastAdvanced(live) ?? progress })
    },
    get current() {
      return reports.get([...raised].at(-1) ?? '')
    },
    get history() {
      return history()
    },
    getReport: id => reports.get(id),
    get clients() {
      return clients.size
    },
    close() {
      clearInterval(keepalive)
      for (const client of clients) {
        try {
          client.close()
        }
        catch {}
      }
      clients.clear()
    },
  }

  return channel
}

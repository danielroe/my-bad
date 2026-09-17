import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorReport, HistoryEntry } from '../types'
import type { BuildProgress, ChannelEvent, LogEntry, ReportRequest } from './protocol'
import type { ClientScope } from './scope'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { json } from 'node:stream/consumers'
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

export interface ChannelOptions {
  /** Number of reports to keep. Default 20. */
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
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** Fetch-style handler returning `undefined` for unknown paths. */
  fetchHandler: (request: Request) => Promise<Response | undefined>
  /** Publish the current error. Naming the request it came from (`requestId`, `METHOD /path?query`) sends it only to the pages that request concerns. */
  setError: (report: ErrorReport, requestId?: string, request?: string) => void
  clearError: (id?: string) => void
  warn: (report: ErrorReport) => void
  log: (entry: Omit<LogEntry, 'timestamp'> & { timestamp?: number }) => void
  /** Publish build progress. Updates carrying a `source` are resolved against the other live sources; `percent: 100` retires one. */
  progress: (progress: BuildProgress) => void
  readonly current: ErrorReport | undefined
  readonly history: HistoryEntry[]
  getReport: (id: string) => ErrorReport | undefined
  /** Number of connected clients. */
  readonly clients: number
  close: () => void
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

interface Client {
  send: (chunk: string) => void
  close: () => void
  scope: ClientScope
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
}

export function createChannel(options: ChannelOptions = {}): Channel {
  const max = options.history ?? 20
  const reports = new Map<string, ErrorReport>()
  const live = new Map<string, BuildProgress>()
  let current: ErrorReport | undefined
  let currentRequest: ReportRequest = {}
  const clients = new Set<Client>()
  const concerned = (client: Client) => concernsClient(client.scope, currentRequest)
  const actions: string[] = []
  if (options.open) {
    actions.push('open')
  }

  const keepalive = setInterval(send, options.keepalive ?? 15_000, ': ping\n\n')
  keepalive.unref?.()

  const helloFrames = new Map<boolean, string>()

  function history(): HistoryEntry[] {
    return [...reports.values()].map(toHistoryEntry)
  }

  function remember(report: ErrorReport): void {
    reports.delete(report.id)
    reports.set(report.id, report)
    while (reports.size > max) {
      reports.delete(reports.keys().next().value!)
    }
    helloFrames.clear()
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
    if (options.sink) {
      Promise.resolve(options.sink(event)).catch(() => {})
    }
  }

  /** The current error is only announced to the pages it concerns; the rest just learn it happened. */
  function hello(scope: ClientScope): string {
    const mine = current !== undefined && concernsClient(scope, currentRequest)
    let frame = helloFrames.get(mine)
    if (!frame) {
      frame = encode({ type: 'hello', payload: { version: __MY_BAD_VERSION__, actions, current: mine ? current : undefined, history: history() } })
      helloFrames.set(mine, frame)
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

  function route(pathname: string): 'events' | 'open' | { history: string } | undefined {
    if (pathname.endsWith('/events')) {
      return 'events'
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

  function historyResponse(id: string): { status: number, body: string } {
    const report = reports.get(id)
    return { status: report ? 200 : 404, body: report ? JSON.stringify(report) : '{}' }
  }

  const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

  const channel: Channel = {
    async handler(req, res) {
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
        }
        clients.add(client)
        client.send(hello(client.scope))
        req.on('close', () => clients.delete(client))
        return true
      }
      if (matched === 'open') {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return true
        }
        const body = await json(req).catch(() => undefined)
        res.writeHead(await openStatus(req.headers['content-type'], body)).end()
        return true
      }
      const { status, body } = historyResponse(matched.history)
      res.writeHead(status, JSON_HEADERS)
      res.end(body)
      return true
    },

    async fetchHandler(request) {
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
            }
            clients.add(client)
            client.send(hello(client.scope))
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
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        return new Response(null, { status: await openStatus(request.headers.get('content-type'), await request.json().catch(() => undefined)) })
      }
      const { status, body } = historyResponse(matched.history)
      return new Response(body, { status, headers: JSON_HEADERS })
    },

    setError(report, requestId, request) {
      remember(report)
      current = report
      currentRequest = { ...(requestId && { requestId }), ...(request && { request }) }
      broadcast({ type: 'error:set', payload: { report, history: history(), ...currentRequest } }, concerned)
      send(encode({ type: 'history', payload: { history: history() } }), client => !concerned(client))
    },
    clearError(id) {
      if (id && current?.id !== id) {
        return
      }
      broadcast({ type: 'error:clear', payload: { id } }, concerned)
      current = undefined
      currentRequest = {}
      helloFrames.clear()
    },
    warn(report) {
      const warning = { ...report, kind: 'warning' as const }
      remember(warning)
      broadcast({ type: 'warning', payload: { report: warning, history: history() } })
    },
    log(entry) {
      broadcast({ type: 'log', payload: { timestamp: Date.now(), ...entry } })
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
      return current
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

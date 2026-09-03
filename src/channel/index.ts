import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorReport, HistoryEntry } from '../types'
import type { BuildProgress, ChannelEvent, LogEntry } from './protocol'
import { json } from 'node:stream/consumers'
import { version } from '../../package.json'
import { openInEditor } from './open'
import { toHistoryEntry } from './protocol'

export { openInEditor } from './open'

export type { BuildProgress, ChannelEvent, LogEntry, LogLevel } from './protocol'
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
   * a function receives the location. Omit to disable the action.
   */
  open?: boolean | ((request: OpenRequest) => void | Promise<void>)
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
  setError: (report: ErrorReport) => void
  clearError: (id?: string) => void
  warn: (report: ErrorReport) => void
  log: (entry: Omit<LogEntry, 'timestamp'> & { timestamp?: number }) => void
  progress: (progress: BuildProgress) => void
  readonly current: ErrorReport | undefined
  readonly history: HistoryEntry[]
  getReport: (id: string) => ErrorReport | undefined
  /** Number of connected clients. */
  readonly clients: number
  close: () => void
}

interface Client {
  send: (chunk: string) => void
  close: () => void
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
  let current: ErrorReport | undefined
  const clients = new Set<Client>()
  const actions: string[] = []
  if (options.open) {
    actions.push('open')
  }

  const keepalive = setInterval(send, options.keepalive ?? 15_000, ': ping\n\n')
  keepalive.unref?.()

  function history(): HistoryEntry[] {
    return [...reports.values()].map(toHistoryEntry)
  }

  function remember(report: ErrorReport): void {
    reports.delete(report.id)
    reports.set(report.id, report)
    while (reports.size > max) {
      reports.delete(reports.keys().next().value!)
    }
  }

  function send(chunk: string): void {
    for (const client of clients) {
      try {
        client.send(chunk)
      }
      catch {
        clients.delete(client)
      }
    }
  }

  function broadcast(event: ChannelEvent): void {
    send(encode(event))
    if (options.sink) {
      Promise.resolve(options.sink(event)).catch(() => {})
    }
  }

  function hello(): ChannelEvent {
    return { type: 'hello', payload: { version, actions, current, history: history() } }
  }

  async function open(request: OpenRequest): Promise<boolean> {
    if (typeof options.open === 'function') {
      await options.open(request)
      return true
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

  async function openStatus(body: unknown): Promise<number> {
    const request = parseOpen(body)
    return request && await open(request).catch(() => false) ? 204 : 400
  }

  function historyResponse(id: string): { status: number, body: string } {
    const report = reports.get(id)
    return { status: report ? 200 : 404, body: report ? JSON.stringify(report) : '{}' }
  }

  const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

  const channel: Channel = {
    async handler(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const matched = route(pathname)
      if (!matched) {
        return false
      }
      if (matched === 'events') {
        res.writeHead(200, SSE_HEADERS)
        res.flushHeaders?.()
        const client: Client = {
          send: chunk => void res.write(chunk),
          close: () => res.end(),
        }
        clients.add(client)
        client.send(encode(hello()))
        req.on('close', () => clients.delete(client))
        return true
      }
      if (matched === 'open') {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return true
        }
        const body = await json(req).catch(() => undefined)
        res.writeHead(await openStatus(body)).end()
        return true
      }
      const { status, body } = historyResponse(matched.history)
      res.writeHead(status, JSON_HEADERS)
      res.end(body)
      return true
    },

    async fetchHandler(request) {
      const matched = route(new URL(request.url).pathname)
      if (!matched) {
        return
      }
      if (matched === 'events') {
        const encoder = new TextEncoder()
        let client: Client | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            client = {
              send: chunk => controller.enqueue(encoder.encode(chunk)),
              close: () => controller.close(),
            }
            clients.add(client)
            client.send(encode(hello()))
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
        return new Response(null, { status: await openStatus(await request.json().catch(() => undefined)) })
      }
      const { status, body } = historyResponse(matched.history)
      return new Response(body, { status, headers: JSON_HEADERS })
    },

    setError(report) {
      remember(report)
      current = report
      broadcast({ type: 'error:set', payload: { report, history: history() } })
    },
    clearError(id) {
      if (id && current && current.id !== id) {
        return
      }
      current = undefined
      broadcast({ type: 'error:clear', payload: { id } })
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
      broadcast({ type: 'build', payload: progress })
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

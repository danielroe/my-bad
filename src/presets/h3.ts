import type { ReportPreset, Section } from '../types'

const DEFAULT_REDACT = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key']

export interface RequestPresetOptions {
  /** Header names (lower-case) whose values are replaced with `[redacted]`. */
  redact?: string[]
  /** Include a collapsed `Headers` section. Default `true`. */
  headers?: boolean
}

interface RequestLike {
  method?: string
  url?: string
  headers?: Headers | Record<string, string | string[] | undefined> | Iterable<[string, string]>
}

function headerEntries(headers: RequestLike['headers']): [string, string][] {
  if (!headers) {
    return []
  }
  if (typeof (headers as Headers).forEach === 'function' && typeof (headers as Headers).get === 'function') {
    const out: [string, string][] = []
    ;(headers as Headers).forEach((value, key) => out.push([key, value]))
    return out
  }
  if (Symbol.iterator in new Object(headers)) {
    return [...(headers as Iterable<[string, string]>)]
  }
  return Object.entries(headers as Record<string, string | string[] | undefined>)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])
}

/** Extract a request-like object from an h3 v1/v2 event, a Fetch `Request`, or a Node `IncomingMessage`. */
export function requestFromContext(context: Record<string, unknown>): RequestLike | undefined {
  const event = context.event as { req?: RequestLike, node?: { req?: RequestLike }, path?: string, method?: string } | undefined
  const direct = (context.request ?? context.req) as RequestLike | undefined
  if (direct) {
    return direct
  }
  if (event?.req && (event.req.headers || event.req.url)) {
    return event.req
  }
  if (event?.node?.req) {
    return event.node.req
  }
  if (event?.path) {
    return { method: event.method, url: event.path }
  }
}

/** Adds `Request` and `Headers` sections from `context.event`, `context.request` or `context.req`. */
export function requestPreset(options: RequestPresetOptions = {}): ReportPreset {
  const redact = new Set([...DEFAULT_REDACT, ...(options.redact ?? []).map(name => name.toLowerCase())])
  return {
    plugins: [{
      name: 'request',
      transform(report, ctx) {
        if (report.sections.some(section => section.id === 'request')) {
          return
        }
        const request = requestFromContext(ctx.options.context)
        if (!request) {
          return
        }
        const url = request.url ? (request.url.startsWith('/') ? request.url : safeUrl(request.url)) : undefined
        const summary: Record<string, unknown> = {}
        if (request.method) {
          summary.method = request.method
        }
        if (url) {
          summary.url = url
        }
        if (report.status) {
          summary.status = report.status
        }
        const sections: Section[] = [{ id: 'request', title: 'Request', content: summary }]
        if (options.headers !== false) {
          const headers: Record<string, string> = {}
          for (const [key, value] of headerEntries(request.headers)) {
            headers[key.toLowerCase()] = redact.has(key.toLowerCase()) ? '[redacted]' : value
          }
          if (Object.keys(headers).length) {
            sections.push({ id: 'headers', title: 'Headers', content: headers, collapsed: true })
          }
        }
        report.sections.unshift(...sections)
      },
    }],
  }
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  }
  catch {
    return url
  }
}

/** Alias of `requestPreset` with Nitro/h3 runtime frames marked internal. */
export function nitroPreset(options: RequestPresetOptions = {}): ReportPreset {
  const base = requestPreset(options)
  return {
    ...base,
    internal: [/\/node_modules\/(?:nitro|nitropack|h3|nitro-server|@nitro)\//, /^(?:nitro|nitropack|h3|nitro-server|@nitro\/[^/]+)$/, /\/\.output\/server\/(?:chunks\/(?:nitro|_)|index\.mjs)/, /\/\.nitro\//],
  }
}

export { requestPreset as h3Preset }

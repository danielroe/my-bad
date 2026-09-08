import type { IncomingMessage } from 'node:http'

export interface TrustOptions {
  /**
   * Hosts a browser may address the channel through, besides loopback. Entries
   * starting with `.` also match subdomains. `true` accepts any host.
   */
  allowedHosts?: string[] | true
}

/**
 * Whether a request may run channel actions, i.e. it was not made by a page on
 * another origin. `Sec-Fetch-Site` decides it where the browser sends one; an
 * `Origin` must otherwise name the host being addressed. Either way the host
 * must be loopback or allowed, so a DNS-rebound hostname pointing at the
 * machine cannot vouch for itself. Requests with neither header cannot come
 * from a browser (`curl`, editor integrations) and pass.
 */
export function isTrustedRequest(site: string | null | undefined, origin: string | null | undefined, host: string | null | undefined, options: TrustOptions = {}): boolean {
  if (!site && !origin) {
    return true
  }
  if (!host || !isAllowedHost(host, options.allowedHosts)) {
    return false
  }
  if (site) {
    return site === 'same-origin' || site === 'none'
  }
  return originHost(origin!) === host.toLowerCase()
}

export function isAllowedHost(host: string, allowedHosts: string[] | true = []): boolean {
  if (allowedHosts === true) {
    return true
  }
  const name = hostname(host)
  if (!name) {
    return false
  }
  if (name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '::1') {
    return true
  }
  return allowedHosts.some(allowed => allowed.startsWith('.')
    ? name === allowed.slice(1) || name.endsWith(allowed)
    : name === allowed.toLowerCase())
}

/** Hostname without port; IPv6 literals lose their brackets. */
function hostname(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase() || null
  }
  catch {
    return null
  }
}

/** `null` for opaque origins (`Origin: null`), which are never trusted. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase() || null
  }
  catch {
    return null
  }
}

export function isTrustedNodeRequest(req: IncomingMessage, options?: TrustOptions): boolean {
  return isTrustedRequest(header(req, 'sec-fetch-site'), header(req, 'origin'), header(req, 'host'), options)
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function isTrustedFetchRequest(request: Request, options?: TrustOptions): boolean {
  const headers = request.headers
  return isTrustedRequest(headers.get('sec-fetch-site'), headers.get('origin'), headers.get('host') ?? hostOf(request.url), options)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  }
  catch {
    return null
  }
}

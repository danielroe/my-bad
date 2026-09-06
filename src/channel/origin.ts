import type { IncomingMessage } from 'node:http'

/**
 * Whether a request may run channel actions, i.e. it was not made by a page on
 * another origin. `Sec-Fetch-Site` decides it where the browser sends one; an
 * `Origin` must otherwise name the host being addressed. Requests with neither
 * header cannot come from a browser (`curl`, editor integrations) and pass.
 */
export function isTrustedRequest(site: string | null | undefined, origin: string | null | undefined, host: string | null | undefined): boolean {
  if (site) {
    return site === 'same-origin' || site === 'none'
  }
  if (origin) {
    return !!host && originHost(origin) === host.toLowerCase()
  }
  return true
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

export function isTrustedNodeRequest(req: IncomingMessage): boolean {
  return isTrustedRequest(header(req, 'sec-fetch-site'), header(req, 'origin'), header(req, 'host'))
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function isTrustedFetchRequest(request: Request): boolean {
  const headers = request.headers
  return isTrustedRequest(headers.get('sec-fetch-site'), headers.get('origin'), headers.get('host') ?? hostOf(request.url))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  }
  catch {
    return null
  }
}

import type { RawSourceMap } from 'my-bad'
import type { FixtureRuntime } from './types'
import { defineHandler, HTTPError } from 'nitro'
import { serverFetch, useNitroApp } from 'nitro/app'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { errorPageURL } from './url'

interface WebEvent {
  url: URL
  req: Request
}

export const runtime: FixtureRuntime = {
  path: event => (event as WebEvent).url.pathname,
  requestHeaders: event => Object.fromEntries((event as WebEvent).req.headers),
  isHandled: () => false,
  ssrSourceMaps() {
    const nitroApp = useNitroApp() as { ssrSourceMaps?: { getSourceMap: (file: string) => RawSourceMap | undefined } }
    const accessor = nitroApp.ssrSourceMaps
    return accessor ? file => accessor.getSourceMap(file) : undefined
  },
  async fetchErrorPage(event, query, headers) {
    // Nuxt 5 sends the serialised error as one `__nuxt_error_payload` parameter
    // and marks the render internal so the route does not re-enter this handler.
    // The renderer resolves the route to render from `error.url`, which has to
    // be absolute.
    const payload = { ...query, url: (event as WebEvent).req.url }
    const url = errorPageURL(useRuntimeConfig().app?.baseURL ?? '/', { __nuxt_error_payload: JSON.stringify(payload) })
    const res = await serverFetch(url, { headers, redirect: 'manual' }, { nuxt: { '~internal': true, '~rendering-error': true } }).catch(() => null)
    if (!res) {
      return null
    }
    return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), html: await res.text() }
  },
  respond(_event, { status, statusText, headers, body }) {
    return new Response(body, { status, statusText, headers })
  },
}

export function defineFixtureHandler(handler: () => unknown): unknown {
  return defineHandler(handler)
}

export function fixtureHTTPError(status: number, message: string, data: unknown): Error {
  return new HTTPError({ status, message, data })
}

import type { H3Event } from 'h3'
import type { RawSourceMap } from 'my-bad'
import type { FixtureRuntime } from './types'
import { createError, defineEventHandler, getRequestHeaders, send, setResponseHeaders, setResponseStatus } from 'h3'
import { useNitroApp, useRuntimeConfig } from 'nitropack/runtime'
import { errorPageURL } from './url'

export const runtime: FixtureRuntime = {
  path: event => (event as H3Event).path,
  requestHeaders: event => getRequestHeaders(event as H3Event) as Record<string, string>,
  isHandled: event => (event as H3Event).handled,
  ssrSourceMaps() {
    const nitroApp = useNitroApp() as { ssrSourceMaps?: { getSourceMap: (file: string) => RawSourceMap | undefined } }
    const accessor = nitroApp.ssrSourceMaps
    return accessor ? file => accessor.getSourceMap(file) : undefined
  },
  async fetchErrorPage(event, query, headers) {
    const url = errorPageURL(useRuntimeConfig(event as H3Event).app.baseURL, query)
    const res = await useNitroApp().localFetch(url, { headers, redirect: 'manual' }).catch(() => null)
    if (!res) {
      return null
    }
    return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), html: await res.text() }
  },
  respond(event, { status, statusText, headers, body }) {
    setResponseHeaders(event as H3Event, headers ?? {})
    setResponseStatus(event as H3Event, status, statusText)
    return send(event as H3Event, body)
  },
}

export function defineFixtureHandler(handler: () => unknown): unknown {
  return defineEventHandler(handler)
}

export function fixtureHTTPError(status: number, message: string, data: unknown): Error {
  return createError({ statusCode: status, statusMessage: message, data })
}

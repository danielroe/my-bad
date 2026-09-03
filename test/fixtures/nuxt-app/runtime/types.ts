import type { RawSourceMap } from 'my-bad'

export interface FixtureResponse {
  status: number
  statusText?: string
  headers?: Record<string, string>
  body: string
}

export interface FixtureErrorPage {
  status: number
  statusText?: string
  headers: Record<string, string>
  html: string
}

/**
 * The request and response glue that differs between Nuxt 4 (h3 v1 + nitropack
 * v2, mutate-the-event) and Nuxt 5 (h3 v2 + nitro v3, return a `Response`).
 * Everything my-bad related lives in `error-handler.ts`.
 */
export interface FixtureRuntime {
  path: (event: unknown) => string
  requestHeaders: (event: unknown) => Record<string, string>
  isHandled: (event: unknown) => boolean
  /** Nuxt's in-memory SSR sourcemaps, where the version exposes them. */
  ssrSourceMaps: () => ((file: string) => RawSourceMap | undefined) | undefined
  /** Render the user's `error.vue` through the app's own `/__nuxt_error` route. */
  fetchErrorPage: (event: unknown, query: Record<string, string>, headers: Record<string, string>) => Promise<FixtureErrorPage | null>
  respond: (event: unknown, response: FixtureResponse) => unknown
}

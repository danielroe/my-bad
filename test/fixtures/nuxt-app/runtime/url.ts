/** `/__nuxt_error` with the serialised error as query parameters, without pulling in `ufo`. */
export function errorPageURL(baseURL: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value))
    }
  }
  return `${baseURL.replace(/\/+$/, '')}/__nuxt_error?${params}`
}

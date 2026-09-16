const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}

const UNSAFE_RE = /[&<>"']/
const UNSAFE_GLOBAL_RE = /[&<>"']/g

export function escapeHtml(value: unknown): string {
  const text = String(value)
  return UNSAFE_RE.test(text) ? text.replace(UNSAFE_GLOBAL_RE, char => ESCAPES[char]!) : text
}

/**
 * Make JSON safe to embed inside a `<script>` element of a document with any
 * charset. `<` and non-ASCII characters only occur inside JSON strings, where
 * `\uXXXX` is an equivalent escape, so the result still parses.
 */
export function escapeScript(json: string): string {
  return json.replace(/[<\u007F-\uFFFF]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Links are only rendered for schemes a browser cannot execute. Control characters are stripped first, since browsers ignore them when resolving the scheme. */
export function safeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\u0000-\u0020\u007F]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? value : undefined
}

export function attr(name: string, value: unknown): string {
  return value === undefined || value === null || value === false ? '' : ` ${name}="${escapeHtml(value)}"`
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ESCAPES[char]!)
}

/**
 * Make JSON safe to embed inside a `<script>` element of a document with any
 * charset. `<` and non-ASCII characters only occur inside JSON strings, where
 * `\uXXXX` is an equivalent escape, so the result still parses.
 */
export function escapeScript(json: string): string {
  return json.replace(/[<\u007F-\uFFFF]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function attr(name: string, value: unknown): string {
  return value === undefined || value === null || value === false ? '' : ` ${name}="${escapeHtml(value)}"`
}

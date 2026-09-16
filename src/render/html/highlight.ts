import type { Snippet } from '../../types'
import { snippetTokens } from '../../report/tokenize'
import { escapeHtml } from './escape'

export function highlightLine(snippet: Snippet, index: number): string {
  let html = ''
  for (const token of snippetTokens(snippet, index)) {
    html += token.type === 'text' ? escapeHtml(token.text) : `<span class="tk-${token.type}">${escapeHtml(token.text)}</span>`
  }
  return html
}

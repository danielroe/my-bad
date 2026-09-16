import type { Snippet, Token, Tokenizer, TokenType } from '../types'

const KEYWORDS = new Set('abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return satisfies static super switch this throw true try type typeof undefined var void while with yield'.split(' '))

/**
 * Comments end at a line terminator (`\n`, `\r`, U+2028, U+2029) or, for block
 * comments, at their closer; spelling that out as character classes instead of
 * `.*$` and lazy `[\s\S]*?` keeps the match linear for any input.
 */
export const TOKEN_RE = /(\/\/[^\n\r\u2028\u2029]*|\/\*(?:(?!\*\/)[^\n\r\u2028\u2029])*(?:\*\/)?|<!--(?:(?!--!?>)[^\n\r\u2028\u2029])*(?:--!?>)?)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-f]+\b)|(<\/?[a-z][\w.-]*|\/?>)|([a-z_$][\w$-]*)|([{}()[\]])|([=!<>+\-*/%&|^~?:.,;]+)/giu

const GROUPS: TokenType[] = ['comment', 'string', 'number', 'tag', 'variable', 'punctuation', 'operator']

/** Small built-in tokenizer for JS/TS/Vue/HTML/CSS snippets. */
export const defaultTokenizer: Tokenizer = (line, lang) => {
  if (!lang || lang === 'md') {
    return [{ type: 'text', text: line }]
  }
  const tokens: Token[] = []
  let last = 0
  let inTag = false
  TOKEN_RE.lastIndex = 0
  for (let match = TOKEN_RE.exec(line); match; match = TOKEN_RE.exec(line)) {
    if (match.index > last) {
      tokens.push({ type: 'text', text: line.slice(last, match.index) })
    }
    const text = match[0]
    let group = 1
    while (match[group] === undefined) {
      group++
    }
    let type = GROUPS[group - 1]!
    if (type === 'tag') {
      inTag = !text.endsWith('>')
    }
    else if (type === 'variable') {
      if (inTag) {
        type = 'attribute'
      }
      else if (lang === 'css' && line[match.index + text.length] === ':') {
        type = 'attribute'
      }
      else if (KEYWORDS.has(text)) {
        type = 'keyword'
      }
      else if (isUpper(text.charCodeAt(0))) {
        type = 'type'
      }
      else if (line[match.index + text.length] === '(') {
        type = 'function'
      }
      else {
        type = 'text'
      }
    }
    tokens.push({ type, text })
    last = match.index + text.length
  }
  if (last < line.length) {
    tokens.push({ type: 'text', text: line.slice(last) })
  }
  return tokens
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

export function tokenizeLine(line: string, lang: string | undefined, tokenizer?: Tokenizer): Token[] {
  return tokenizer?.(line, lang) ?? defaultTokenizer(line, lang) ?? [{ type: 'text', text: line }]
}

/** Tokens for a snippet line, preferring tokens stored on the report. */
export function snippetTokens(snippet: Snippet, index: number): Token[] {
  return snippet.tokens?.[index] ?? tokenizeLine(snippet.lines[index] ?? '', snippet.lang)
}

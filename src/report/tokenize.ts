import type { Snippet, Token, Tokenizer, TokenType } from '../types'

const KEYWORDS = new Set('abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return satisfies static super switch this throw true try type typeof undefined var void while with yield'.split(' '))

const TOKEN_RE = /(\/\/.*$|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-f]+\b)|(<\/?[a-z][\w.-]*|\/?>)|([a-z_$][\w$-]*)|([{}()[\]])|([=!<>+\-*/%&|^~?:.,;]+)/gimu

const GROUPS: TokenType[] = ['comment', 'string', 'number', 'tag', 'variable', 'punctuation', 'operator']

/** Small built-in tokenizer for JS/TS/Vue/HTML/CSS snippets. */
export const defaultTokenizer: Tokenizer = (line, lang) => {
  if (!lang || lang === 'md') {
    return [{ type: 'text', text: line }]
  }
  const tokens: Token[] = []
  let last = 0
  let inTag = false
  for (const match of line.matchAll(TOKEN_RE)) {
    if (match.index > last) {
      tokens.push({ type: 'text', text: line.slice(last, match.index) })
    }
    const text = match[0]
    let type = GROUPS[match.slice(1).findIndex(value => value !== undefined)]!
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
      else if (/^[A-Z]/.test(text)) {
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

export function tokenizeLine(line: string, lang: string | undefined, tokenizer?: Tokenizer): Token[] {
  return tokenizer?.(line, lang) ?? defaultTokenizer(line, lang) ?? [{ type: 'text', text: line }]
}

/** Tokens for a snippet line, preferring tokens stored on the report. */
export function snippetTokens(snippet: Snippet, index: number): Token[] {
  return snippet.tokens?.[index] ?? tokenizeLine(snippet.lines[index] ?? '', snippet.lang)
}

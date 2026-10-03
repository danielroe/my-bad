import type { Snippet, SnippetContinuation, Token, Tokenizer, TokenType } from '../types'

const KEYWORDS = new Set('abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return satisfies static super switch this throw true try type typeof undefined var void while with yield'.split(' '))

/**
 * Comments end at a line terminator (`\n`, `\r`, U+2028, U+2029) or, for block
 * comments, at their closer; spelling that out as character classes instead of
 * `.*$` and lazy `[\s\S]*?` keeps the match linear for any input.
 */
export const TOKEN_RE = /(\/\/[^\n\r\u2028\u2029]*|\/\*(?:(?!\*\/)[^\n\r\u2028\u2029])*(?:\*\/)?|<!--(?:(?!--!?>)[^\n\r\u2028\u2029])*(?:--!?>)?)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-f]+\b)|(<\/?[a-z][\w.-]*|\/?>)|([a-z_$][\w$-]*)|([{}()[\]])|([=!<>+\-*/%&|^~?:.,;]+)/giu

const GROUPS: TokenType[] = ['comment', 'string', 'number', 'tag', 'variable', 'punctuation', 'operator']

const HTML_COMMENT_CLOSE_RE = /--!?>/

interface Lexed {
  tokens: Token[]
  /** Construct still open at the end of the line. */
  state: SnippetContinuation | undefined
}

/** Offset just past the closer of an open construct, or `-1` when the line does not close it. */
function closeOf(line: string, state: SnippetContinuation): number {
  if (state === 'comment') {
    const at = line.indexOf('*/')
    return at < 0 ? -1 : at + 2
  }
  if (state === 'html-comment') {
    const match = HTML_COMMENT_CLOSE_RE.exec(line)
    return match ? match.index + match[0].length : -1
  }
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code === 92) {
      i++
    }
    else if (code === 96) {
      return i + 1
    }
  }
  return -1
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) {
    slashes++
  }
  return slashes % 2 === 1
}

/** The construct a comment or string token leaves open, if it is unterminated. */
function openedBy(text: string): SnippetContinuation | undefined {
  if (text.startsWith('/*')) {
    return text.length >= 4 && text.endsWith('*/') ? undefined : 'comment'
  }
  if (text.startsWith('<!--')) {
    return text.length >= 7 && (text.endsWith('-->') || text.endsWith('--!>')) ? undefined : 'html-comment'
  }
  if (text.startsWith('`')) {
    return text.length >= 2 && text.endsWith('`') && !isEscaped(text, text.length - 1) ? undefined : 'template'
  }
}

/**
 * Tokenize one line, starting inside `state` when the previous line left a
 * block comment, HTML comment or template literal open.
 */
function tokenizeFrom(line: string, lang: string | undefined, state: SnippetContinuation | undefined): Lexed {
  if (!lang || lang === 'md') {
    return { tokens: [{ type: 'text', text: line }], state: undefined }
  }
  const tokens: Token[] = []
  let last = 0
  if (state) {
    const end = closeOf(line, state)
    const type: TokenType = state === 'template' ? 'string' : 'comment'
    if (end < 0) {
      return { tokens: line ? [{ type, text: line }] : [], state }
    }
    tokens.push({ type, text: line.slice(0, end) })
    last = end
  }
  let inTag = false
  let open: SnippetContinuation | undefined
  TOKEN_RE.lastIndex = last
  for (let match = TOKEN_RE.exec(line); match; match = TOKEN_RE.exec(line)) {
    if (match.index > last) {
      tokens.push({ type: 'text', text: line.slice(last, match.index) })
    }
    let text = match[0]
    let group = 1
    while (match[group] === undefined) {
      group++
    }
    let type = GROUPS[group - 1]!
    open = undefined
    if (group <= 2) {
      open = openedBy(text)
      if (open === 'template') {
        text = line.slice(match.index)
      }
      else if (open && match.index + text.length < line.length) {
        open = undefined
      }
    }
    else if (type === 'tag') {
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
    TOKEN_RE.lastIndex = last
  }
  if (last < line.length) {
    tokens.push({ type: 'text', text: line.slice(last) })
    open = undefined
  }
  return { tokens, state: open }
}

/** Small built-in tokenizer for JS/TS/Vue/HTML/CSS snippets. */
export const defaultTokenizer: Tokenizer = (line, lang) => tokenizeFrom(line, lang, undefined).tokens

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

/**
 * Tokenize consecutive lines with the built-in tokenizer, carrying block
 * comments, HTML comments and template literals from one line to the next.
 */
export function tokenizeLines(lines: string[], lang: string | undefined, state?: SnippetContinuation): Token[][] {
  const out: Token[][] = []
  for (const line of lines) {
    const lexed = tokenizeFrom(line, lang, state)
    out.push(lexed.tokens)
    state = lexed.state
  }
  return out
}

/** Lines of context before a snippet that are scanned for a construct it starts inside. */
const CONTEXT_LINES = 30
const CONTEXT_CHARS = 2400

const OPENER_RE = /\/\/|\/\*|<!--|[`'"]/g
const HTML_CLOSE_RE = /--!?>/g
const TEMPLATE_STOP_RE = /[`\\]/g
const DOUBLE_STOP_RE = /["\\\n]/g
const SINGLE_STOP_RE = /['\\\n]/g

/** End of a construct opened just before `from`, found by jumping between `stop` characters, or `-1`. */
function closeAfter(text: string, from: number, stop: RegExp): number {
  stop.lastIndex = from
  for (let match = stop.exec(text); match; match = stop.exec(text)) {
    if (match[0] !== '\\') {
      return match.index + 1
    }
    stop.lastIndex = match.index + 2
  }
  return -1
}

/**
 * The construct open at the end of `text`, judged with only the rules that
 * decide it: comments, quoted strings and template literals.
 */
function scanState(text: string): SnippetContinuation | undefined {
  let at = 0
  while (at < text.length) {
    OPENER_RE.lastIndex = at
    const match = OPENER_RE.exec(text)
    if (!match) {
      return
    }
    at = match.index + match[0].length
    switch (match[0]) {
      case '//': {
        const newline = text.indexOf('\n', at)
        at = newline < 0 ? text.length : newline + 1
        break
      }
      case '/*': {
        const close = text.indexOf('*/', at)
        if (close < 0) {
          return 'comment'
        }
        at = close + 2
        break
      }
      case '<!--': {
        HTML_CLOSE_RE.lastIndex = at
        const close = HTML_CLOSE_RE.exec(text)
        if (!close) {
          return 'html-comment'
        }
        at = close.index + close[0].length
        break
      }
      case '`':
        at = closeAfter(text, at, TEMPLATE_STOP_RE)
        if (at < 0) {
          return 'template'
        }
        break
      default: {
        const end = closeAfter(text, at, match[0] === '"' ? DOUBLE_STOP_RE : SINGLE_STOP_RE)
        at = end < 0 ? text.length : end
      }
    }
  }
}

/**
 * The construct left open where the line starting at `end` begins, judged
 * from at most `CONTEXT_LINES` lines and `CONTEXT_CHARS` characters before it.
 */
export function continuationAt(contents: string, end: number, lang: string | undefined): SnippetContinuation | undefined {
  if (!lang || lang === 'md' || end <= 0) {
    return
  }
  let from = end
  for (let n = 0; n < CONTEXT_LINES && from > 0 && end - from < CONTEXT_CHARS; n++) {
    from = (from >= 2 ? contents.lastIndexOf('\n', from - 2) : -1) + 1
  }
  if (end - from > CONTEXT_CHARS) {
    const cut = contents.indexOf('\n', end - CONTEXT_CHARS)
    from = cut < 0 ? end : cut + 1
  }
  if (from >= end) {
    return
  }
  const context = contents.slice(from, end - 1)
  return context.includes('/*') || context.includes('<!--') || context.includes('`') ? scanState(context) : undefined
}

interface Lexing {
  lines: Token[][]
  state: SnippetContinuation | undefined
}

/** Lines tokenized so far per snippet, extended only as far as a renderer asks. */
const lexed = new WeakMap<Snippet, Lexing>()

/**
 * Built-in tokens for one line of a snippet. Cropped snippets are tokenized
 * line by line, since the text cut from each line may open or close a construct.
 */
function lineTokens(snippet: Snippet, index: number): Token[] {
  const line = snippet.lines[index] ?? ''
  if (snippet.offset !== undefined) {
    return defaultTokenizer(line, snippet.lang) ?? [{ type: 'text', text: line }]
  }
  let lexing = lexed.get(snippet)
  if (!lexing) {
    lexing = { lines: [], state: snippet.continues }
    lexed.set(snippet, lexing)
  }
  while (lexing.lines.length <= index && lexing.lines.length < snippet.lines.length) {
    const next = tokenizeFrom(snippet.lines[lexing.lines.length]!, snippet.lang, lexing.state)
    lexing.lines.push(next.tokens)
    lexing.state = next.state
  }
  return lexing.lines[index] ?? [{ type: 'text', text: line }]
}

/** Tokens for a snippet line, preferring tokens stored on the report. */
export function snippetTokens(snippet: Snippet, index: number): Token[] {
  return snippet.tokens?.[index] ?? lineTokens(snippet, index)
}

/** Tokens for a snippet with a custom tokenizer, falling back to the built-in one for lines it declines. */
export function tokenizeSnippet(snippet: Snippet, tokenizer: Tokenizer): Token[][] {
  return snippet.lines.map((line, index) => tokenizer(line, snippet.lang) ?? lineTokens(snippet, index))
}

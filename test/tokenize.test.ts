import type { SnippetContinuation, Token, TokenType } from '../src/types'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createReport, renderAnsi } from '../src'
import { renderSnippet } from '../src/render/html/view'
import { continuationAt, defaultTokenizer, TOKEN_RE, tokenizeLines } from '../src/report/tokenize'

/** The expression before the comment alternatives were rewritten without `$` and lazy `[\s\S]*?`. */
const PREVIOUS_RE = /(\/\/.*$|\/\*[\s\S]*?(?:\*\/|$)|<!--[\s\S]*?(?:--!?>|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-f]+\b)|(<\/?[a-z][\w.-]*|\/?>)|([a-z_$][\w$-]*)|([{}()[\]])|([=!<>+\-*/%&|^~?:.,;]+)/gimu

function lexemes(re: RegExp, line: string): string[] {
  const out: string[] = []
  re.lastIndex = 0
  for (let match = re.exec(line); match; match = re.exec(line)) {
    let group = 1
    while (match[group] === undefined) {
      group++
    }
    out.push(`${group}@${match.index}:${match[0]}`)
  }
  return out
}

const alphabet = ['a', 'b', 'e', 'x', '_', '$', '-', '0', '1', '.', ';', ':', '/', '*', '<', '>', '!', '=', '+', '"', '\'', '`', '\\', '{', ')', ' ', '\n', '\r', '\u2028', '\u2029', '\u017F', 'é', '😀', '\uD83D']
const line = fc.oneof(
  fc.array(fc.constantFrom(...alphabet), { maxLength: 24 }).map(chars => chars.join('')),
  fc.string({ maxLength: 40 }),
)

describe('tOKEN_RE', () => {
  it('lexes comments exactly as the previous expression did', () => {
    const cases = ['// c', '// c\nb', '//\r//', '/* x */ y', '/* x', '/*/', '/**/', '/* * x*/', '/*\u2028x*/', '/*\rx', '<!-- x -->', '<!-- x --!>', '<!-- x', '<!---->', '<!--->', '<!-- a\n-->', '// a\u2029b', '////////', '/*//*/', '<!--*/-->']
    for (const text of cases) {
      expect(lexemes(TOKEN_RE, text), JSON.stringify(text)).toEqual(lexemes(PREVIOUS_RE, text))
    }
    fc.assert(fc.property(line, (text) => {
      expect(lexemes(TOKEN_RE, text), JSON.stringify(text)).toEqual(lexemes(PREVIOUS_RE, text))
    }), { numRuns: 50000 })
  })

  it('stays linear on long runs of comment openers', () => {
    for (const text of ['//'.repeat(50_000), '/*'.repeat(50_000), '<!--'.repeat(25_000), `/*${'*'.repeat(100_000)}`, `<!--${'-'.repeat(100_000)}`]) {
      const start = performance.now()
      lexemes(TOKEN_RE, text)
      expect(performance.now() - start).toBeLessThan(200)
    }
  })
})

const KEYWORDS = new Set('abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return satisfies static super switch this throw true try type typeof undefined var void while with yield'.split(' '))
const GROUPS = ['comment', 'string', 'number', 'tag', 'variable', 'punctuation', 'operator'] as const

/** The line tokenizer before it carried state between lines. */
function previousTokenizer(line: string, lang: string | undefined): Token[] {
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
    let type: TokenType = GROUPS[group - 1]!
    if (type === 'tag') {
      inTag = !text.endsWith('>')
    }
    else if (type === 'variable') {
      const next = line[match.index + text.length]
      type = inTag || (lang === 'css' && next === ':') ? 'attribute' : KEYWORDS.has(text) ? 'keyword' : /^[A-Z]/.test(text) ? 'type' : next === '(' ? 'function' : 'text'
    }
    tokens.push({ type, text })
    last = match.index + text.length
  }
  if (last < line.length) {
    tokens.push({ type: 'text', text: line.slice(last) })
  }
  return tokens
}

/** An unterminated template literal now runs to the end of the line, where the old tokenizer stopped at a `\` before a line terminator. */
function mergeTrailingTemplate(tokens: Token[]): Token[] {
  const closed = (text: string) => text.length >= 2 && text.endsWith('`') && text.match(/\\*`$/)![0].length % 2 === 1
  const index = tokens.findIndex(token => token.type === 'string' && token.text.startsWith('`') && !closed(token.text))
  if (index < 0 || index === tokens.length - 1) {
    return tokens
  }
  return [...tokens.slice(0, index), { type: 'string', text: tokens.slice(index).map(token => token.text).join('') }]
}

describe('stateful tokenizer', () => {
  it('tokenizes a single line as before', () => {
    fc.assert(fc.property(line, fc.constantFrom('ts', 'vue', 'css', 'html', undefined), (text, lang) => {
      const single = text.split('\n')[0]!
      expect(defaultTokenizer(single, lang)).toEqual(mergeTrailingTemplate(previousTokenizer(single, lang)))
      expect(tokenizeLines([single], lang)[0]).toEqual(defaultTokenizer(single, lang))
    }), { numRuns: 20000 })
  })

  it('never drops or reorders text', () => {
    fc.assert(fc.property(fc.array(line, { maxLength: 6 }), fc.constantFrom<SnippetContinuation | undefined>('comment', 'html-comment', 'template', undefined), (lines, state) => {
      const flat = lines.flatMap(text => text.split('\n'))
      expect(tokenizeLines(flat, 'ts', state).map(tokens => tokens.map(token => token.text).join(''))).toEqual(flat)
    }), { numRuns: 5000 })
  })

  it('carries block comments, HTML comments and template literals across lines', () => {
    const types = (lines: string[], lang = 'ts', state?: SnippetContinuation) => tokenizeLines(lines, lang, state).map(tokens => tokens.filter(token => token.text.trim()).map(token => `${token.type}:${token.text}`))
    expect(types(['/* open', 'still comment', 'end */ const a = 1'])).toEqual([
      ['comment:/* open'],
      ['comment:still comment'],
      ['comment:end */', 'keyword:const', 'text:a', 'operator:=', 'number:1'],
    ])
    expect(types(['const q = `select', '  $' + '{id} from \\` t', '` + x'])).toEqual([
      ['keyword:const', 'text:q', 'operator:=', 'string:`select'],
      ['string:  $' + '{id} from \\` t'],
      ['string:`', 'operator:+', 'text:x'],
    ])
    expect(types(['<!-- a', 'b --> <div>'], 'vue')).toEqual([['comment:<!-- a'], ['comment:b -->', 'tag:<div', 'tag:>']])
    expect(types(['still inside */ x'], 'ts', 'comment')[0]![0]).toBe('comment:still inside */')
    expect(types(['/* closed */', 'plain'])).toEqual([['comment:/* closed */'], ['text:plain']])
    expect(types(['// line /* not a block', 'plain'])).toEqual([['comment:// line /* not a block'], ['text:plain']])
  })

  it('finds the construct a snippet starts inside from bounded context before it', () => {
    const file = ['const a = 1', '/**', ' * docs', ' * more docs', ' */', 'function f() {}'].join('\n')
    const startOf = (n: number) => file.split('\n').slice(0, n - 1).join('\n').length + 1
    expect(continuationAt(file, startOf(3), 'ts')).toBe('comment')
    expect(continuationAt(file, startOf(6), 'ts')).toBeUndefined()
    expect(continuationAt(file, startOf(1), 'ts')).toBeUndefined()
    expect(continuationAt(file, startOf(3), 'md')).toBeUndefined()
    const template = 'const html = `\n<div>\n  x\n</div>`\nnext'
    expect(continuationAt(template, template.indexOf('<div>'), 'ts')).toBe('template')
    expect(continuationAt('/*\n'.concat('x\n'.repeat(100), 'y'), 202, 'ts')).toBeUndefined()
    const wide = `/*\n${'x'.repeat(10_000)}\ny`
    expect(continuationAt(wide, wide.length - 1, 'ts')).toBeUndefined()
  })

  it('highlights a snippet that starts inside a comment in HTML and ANSI', async () => {
    const contents = ['/**', ' * explains', ' * the failure', ' */', 'throw new Error(\'x\')', 'export {}'].join('\n')
    const error = new Error('x')
    error.stack = 'Error: x\n    at f (/proj/a.ts:5:1)'
    const report = await createReport(error, { cwd: '/proj', snippetLines: 2, loaders: [{ name: 'memory', read: () => contents }] })
    const snippet = report.frames[0]!.snippet!
    expect(snippet).toMatchObject({ start: 3, continues: 'comment' })
    expect(renderSnippet(snippet, 5, 1)).toContain('<span class="tk-comment"> * the failure</span>')
    const ansi = renderAnsi(report, { colors: true, cwd: '/proj', snippetContext: 2 })
    expect(ansi.split('\n').find(row => row.includes('the failure'))).toContain('\u001B[2m')
  })

  it('calls a custom tokenizer line by line and falls back to the built-in one for lines it declines', async () => {
    const contents = ['/* open', 'inside', 'close */ const a = 1', 'custom line'].join('\n')
    const error = new Error('x')
    error.stack = 'Error: x\n    at f (/proj/a.ts:3:1)'
    const calls: Array<[string, string | undefined]> = []
    const tokenizer = (line: string, lang: string | undefined): Token[] | undefined => {
      calls.push([line, lang])
      return line === 'custom line' ? [{ type: 'keyword', text: line }] : undefined
    }
    const report = await createReport(error, { cwd: '/proj', snippetLines: 2, tokenizer, loaders: [{ name: 'memory', read: () => contents }] })
    const snippet = report.frames[0]!.snippet!
    expect(calls).toEqual(snippet.lines.map(line => [line, 'ts']))
    expect(snippet.tokens![1]).toEqual([{ type: 'comment', text: 'inside' }])
    expect(snippet.tokens![3]).toEqual([{ type: 'keyword', text: 'custom line' }])
    expect(renderSnippet(snippet, 3)).toContain('<span class="tk-keyword">custom line</span>')
  })

  it('keeps cropped snippets line by line', async () => {
    const snippet = { start: 1, lines: ['/* a\u2026', 'b */'], lang: 'ts', offset: 10 }
    expect(renderSnippet(snippet, 2)).not.toContain('<span class="tk-comment">b */</span>')
  })

  it('stays linear on long continued lines', () => {
    for (const state of ['comment', 'html-comment', 'template'] as const) {
      const start = performance.now()
      tokenizeLines(['\\'.repeat(100_000), '*'.repeat(100_000), '-'.repeat(100_000)], 'ts', state)
      expect(performance.now() - start).toBeLessThan(200)
    }
  })
})

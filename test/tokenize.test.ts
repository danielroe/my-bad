import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TOKEN_RE } from '../src/report/tokenize'

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

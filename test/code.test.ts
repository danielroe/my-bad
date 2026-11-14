import { describe, expect, it } from 'vitest'
import { codeSpans, plainText } from '../src/report/code'

describe('codeSpans', () => {
  it('splits text at matched backticks', () => {
    expect(codeSpans('Pass a `name` prop to `<Widget>`.')).toEqual([
      { text: 'Pass a ' },
      { text: 'name', code: true },
      { text: ' prop to ' },
      { text: '<Widget>', code: true },
      { text: '.' },
    ])
  })

  it('closes a span only with a run of the same length', () => {
    expect(codeSpans('Use ``a`b`` here')).toEqual([
      { text: 'Use ' },
      { text: 'a`b', code: true },
      { text: ' here' },
    ])
    expect(codeSpans('`` ` ``')).toEqual([
      { text: '`', code: true },
    ])
  })

  it('leaves an unmatched run literal', () => {
    expect(codeSpans('Unexpected token `')).toEqual([
      { text: 'Unexpected token `' },
    ])
    expect(codeSpans('a ``b` c `d')).toEqual([
      { text: 'a ``b' },
      { text: 'c', code: true },
      { text: 'd' },
    ])
  })

  it('takes backslashes inside a span literally', () => {
    expect(codeSpans('Unexpected token `\\`')).toEqual([
      { text: 'Unexpected token ' },
      { text: '\\', code: true },
    ])
  })

  it('turns line endings into spaces and trims one space from each end', () => {
    expect(codeSpans('`  a\nb  `')).toEqual([
      { text: ' a b ', code: true },
    ])
    expect(codeSpans('`  `')).toEqual([
      { text: '  ', code: true },
    ])
  })

  it('does not nest spans', () => {
    expect(codeSpans('`a `b` c`')).toEqual([
      { text: 'a ', code: true },
      { text: 'b' },
      { text: ' c', code: true },
    ])
  })
})

describe('plainText', () => {
  it('drops the delimiters only when spans are enabled', () => {
    expect(plainText('Pass `name` here, not `', true)).toBe('Pass name here, not `')
    expect(plainText('Pass `name` here', false)).toBe('Pass `name` here')
    expect(plainText('Pass `name` here', undefined)).toBe('Pass `name` here')
  })
})

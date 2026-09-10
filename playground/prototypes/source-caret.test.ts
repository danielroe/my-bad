import { describe, expect, it } from 'vitest'
import { columnCaret } from './source-caret'

describe('reported source columns', () => {
  it('preserves the column for a property access and an Error construction alike', () => {
    expect(columnCaret('  return employee!.name', 20)).toBe(`${' '.repeat(19)}^`)
    expect(columnCaret('  throw new Error(message)', 9)).toBe('        ^')
  })

  it('omits pointers into indentation without moving them to another column', () => {
    const wrapper = '    throw new Error(message, { cause })'
    expect(columnCaret(wrapper, 1)).toBeUndefined()
    expect(columnCaret(wrapper, 4)).toBeUndefined()
    expect(columnCaret(wrapper, 5)).toBe('    ^')
    expect(columnCaret('\t  throw error', 2)).toBeUndefined()
    expect(columnCaret('   ', 1)).toBeUndefined()
    expect(columnCaret('throw error', 1)).toBe('^')
  })

  it('preserves tabs for alignment with the original source', () => {
    expect(columnCaret('\treturn employee.name', 9)).toBe('\t       ^')
  })

  it('allows an end-of-line diagnostic, including an empty line', () => {
    expect(columnCaret('foo(', 5)).toBe('    ^')
    expect(columnCaret('', 1)).toBe('^')
  })

  it.each([undefined, 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 100])('does not invent a pointer for column %s', (column) => {
    expect(columnCaret('return value', column)).toBeUndefined()
  })
})

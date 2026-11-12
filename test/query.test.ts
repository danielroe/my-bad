import { describe, expect, it } from 'vitest'
import { createProblemReport } from '../src'
import { parseQuery, setFacet, suggest } from '../src/render/html/problems'

describe('filter query', () => {
  it('splits words, exclusions and keys, and normalises level names', () => {
    expect(parseQuery('Type  -nme is:error,warn source:eslint -file:node_modules "two words" C:\\x')).toEqual({
      words: {
        include: ['type', 'two words', 'c:\\x'],
        exclude: ['nme'],
      },
      is: {
        include: ['error', 'warning'],
        exclude: [],
      },
      source: {
        include: ['eslint'],
        exclude: [],
      },
      file: {
        include: [],
        exclude: ['node_modules'],
      },
    })
    expect(parseQuery('is:errors -is:info')).toMatchObject({
      is: {
        include: ['error'],
        exclude: ['info'],
      },
    })
    expect(parseQuery('')).toMatchObject({
      words: { include: [], exclude: [] },
    })
  })

  it('sets or clears one key of a query, leaving the rest as typed', () => {
    expect(setFacet('', 'is', 'warning')).toBe('is:warning ')
    expect(setFacet('nme is:warning', 'is', 'error')).toBe('nme is:error ')
    expect(setFacet('nme is:warning ', 'is')).toBe('nme ')
    expect(setFacet('is:error', 'is')).toBe('')
  })
})

describe('filter suggestions', () => {
  const problem = (message: string, kind: 'error' | 'warning', file: string) => ({
    ...createProblemReport({
      name: 'TS',
      message,
      kind,
      file,
      line: 1,
    }, { cwd: '/proj' }),
    id: message,
  })
  const index = {
    history: [],
    problems: [
      {
        source: 'ts',
        label: 'TypeScript',
        errors: 1,
        warnings: 1,
        reports: [
          problem('Type mismatch', 'error', '/proj/src/a.ts'),
          problem('Unused', 'warning', '/proj/src/b.ts'),
        ],
      },
      {
        source: 'eslint',
        label: 'ESLint',
        errors: 0,
        warnings: 1,
        reports: [
          problem('Prefer const', 'warning', '/proj/src/b.ts'),
        ],
      },
    ],
  }
  const offered = (text: string) => {
    const result = suggest(index, {}, '/proj', text)
    return {
      base: result.base,
      negate: result.negate,
      groups: result.groups.map(({ key, items }) => [
        key,
        items.map(item => `${item.token} ${item.count}`),
      ]),
    }
  }

  it('offers every level, source and file with what each would list', () => {
    expect(offered('').groups).toEqual([
      [
        'is',
        ['is:error 1', 'is:warning 2'],
      ],
      [
        'source',
        ['source:ts 2', 'source:eslint 1'],
      ],
      [
        'file',
        ['file:src/b.ts 2', 'file:src/a.ts 1'],
      ],
    ])
  })

  it('narrows the offer to the word being typed, and counts against the rest of the query', () => {
    expect(offered('esl')).toEqual({
      base: '',
      negate: false,
      groups: [
        [
          'source',
          ['source:eslint 1'],
        ],
      ],
    })
    expect(offered('so')).toMatchObject({
      groups: [
        [
          'source',
          ['source:ts 2', 'source:eslint 1'],
        ],
      ],
    })
    expect(offered('file:a')).toMatchObject({
      groups: [
        [
          'file',
          ['file:src/a.ts 1'],
        ],
      ],
    })
    expect(offered('-esl')).toMatchObject({
      negate: true,
      groups: [
        [
          'source',
          ['source:eslint 1'],
        ],
      ],
    })
    expect(offered('source:eslint ')).toMatchObject({
      base: 'source:eslint ',
      groups: [
        [
          'is',
          ['is:warning 1'],
        ],
        [
          'source',
          ['source:ts 2'],
        ],
        [
          'file',
          ['file:src/b.ts 1'],
        ],
      ],
    })
  })
})

import { readFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { describe, expect, it } from 'vitest'
import { decodeSourceMap } from '../src/loaders/decode'

const maps = {
  inline: {
    version: 3,
    sources: ['../src/lib.ts'],
    names: [],
    mappings: ';AAAO,SAAS,QAAQ,OAAe;CACrC,MAAM,IAAI,MAAM,aAAa,OAAO;AACtC',
  },
  fixture: JSON.parse(readFileSync(new URL('./fixtures/basic/dist/sidecar/thrower.mjs.map', import.meta.url), 'utf8')),
  multi: {
    version: 3,
    sources: ['a.ts', 'b.ts'],
    names: ['foo', 'bar'],
    mappings: 'AAAAA,EAAE,GCCCC;;A,IDAI;;;KCEK',
  },
  sections: {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA,EAAE;AACA' } },
      { offset: { line: 2, column: 10 }, map: { version: 3, sources: ['b.ts'], names: [], mappings: 'AAAA,IAAI;EACE' } },
    ],
  },
}

describe('decodeSourceMap', () => {
  for (const [name, raw] of Object.entries(maps)) {
    it(`matches node:module SourceMap for the ${name} map`, () => {
      const node = new SourceMap(raw)
      const ours = decodeSourceMap(raw)
      for (let line = 0; line < 12; line++) {
        for (let column = 0; column < 40; column++) {
          const { name: _, ...expected } = node.findEntry(line, column) as { name?: string }
          expect(ours.findEntry(line, column), `${line}:${column}`).toEqual(expected)
        }
      }
    })
  }

  it('rejects invalid mappings', () => {
    expect(() => decodeSourceMap({ mappings: 'A!' })).toThrow()
  })
})

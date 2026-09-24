export interface SourceMapEntry {
  generatedLine: number
  generatedColumn: number
  originalSource?: string
  originalLine?: number
  originalColumn?: number
}

/** `findEntry` takes 0-based positions and returns the nearest preceding segment. */
export interface SourceMapLookup {
  findEntry: (line: number, column: number) => SourceMapEntry | Record<string, never>
}

interface RawMap {
  mappings?: string
  sources?: (string | null)[]
  sections?: Array<{ offset: { line: number, column: number }, map: RawMap }>
}

const BASE64 = new Int8Array(128).fill(-1)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) {
  BASE64[c.charCodeAt(0)] = i
}

function decodeMappings(mappings: string, raw: RawMap): SourceMapEntry[] {
  const entries: SourceMapEntry[] = []
  const state = [0, 0, 0, 0, 0]
  let line = 0
  let i = 0
  while (i < mappings.length) {
    const char = mappings[i]
    if (char === ';') {
      line++
      state[0] = 0
      i++
      continue
    }
    if (char === ',') {
      i++
      continue
    }
    let field = 0
    const fields: number[] = []
    while (i < mappings.length && mappings[i] !== ',' && mappings[i] !== ';') {
      let value = 0
      let shift = 0
      let digit: number
      do {
        digit = BASE64[mappings.charCodeAt(i++)] ?? -1
        if (digit < 0) {
          throw new SyntaxError('Invalid source map mappings')
        }
        value += (digit & 31) << shift
        shift += 5
      } while (digit & 32)
      const next = (state[field] ?? 0) + (value & 1 ? -(value >>> 1) : value >>> 1)
      state[field] = next
      fields.push(next)
      field++
    }
    const entry: SourceMapEntry = { generatedLine: line, generatedColumn: fields[0]! }
    if (fields.length >= 4) {
      entry.originalSource = raw.sources?.[fields[1]!] ?? undefined
      entry.originalLine = fields[2]
      entry.originalColumn = fields[3]
    }
    entries.push(entry)
  }
  return entries
}

function decodeEntries(raw: RawMap): SourceMapEntry[] {
  if (!raw.sections) {
    return decodeMappings(raw.mappings ?? '', raw)
  }
  return raw.sections.flatMap(({ offset, map }) => decodeEntries(map).map(entry => ({
    ...entry,
    generatedLine: entry.generatedLine + offset.line,
    generatedColumn: entry.generatedColumn + (entry.generatedLine === 0 ? offset.column : 0),
  })))
}

export function decodeSourceMap(raw: RawMap): SourceMapLookup {
  const entries = decodeEntries(raw).sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn)
  return {
    findEntry(line, column) {
      let lo = 0
      let hi = entries.length - 1
      let found: SourceMapEntry | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const entry = entries[mid]!
        if (entry.generatedLine < line || (entry.generatedLine === line && entry.generatedColumn <= column)) {
          found = entry
          lo = mid + 1
        }
        else {
          hi = mid - 1
        }
      }
      return found ?? {}
    },
  }
}

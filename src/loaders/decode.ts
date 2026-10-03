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
  /** Contents the map embeds for a source, as named by `originalSource`. */
  sourceContent?: (source: string) => string | undefined
  /** Whether the map, or the section that names the source, lists it as ignored. */
  ignoredSource?: (source: string) => boolean
}

interface RawMap {
  mappings?: string
  sources?: (string | null)[]
  sourcesContent?: (string | null)[]
  sourceRoot?: string
  ignoreList?: number[]
  x_google_ignoreList?: number[]
  sections?: Array<{ offset: { line: number, column: number }, map: RawMap }>
}

/**
 * Sources of an index map's sections are named with the section's
 * `sourceRoot`, which the top-level resolution never sees.
 */
function sectionRoot(map: RawMap, parent: string): string {
  return map.sourceRoot ? `${parent}${map.sourceRoot.replace(/\/?$/, '/')}` : parent
}

const BASE64 = new Int8Array(128).fill(-1)
for (const [i, c] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) {
  BASE64[c.charCodeAt(0)] = i
}

function decodeMappings(mappings: string, raw: RawMap, root: string): SourceMapEntry[] {
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
      const source = raw.sources?.[fields[1]!]
      entry.originalSource = typeof source === 'string' ? (root ? `${root}${source}` : source) : undefined
      entry.originalLine = fields[2]
      entry.originalColumn = fields[3]
    }
    entries.push(entry)
  }
  return entries
}

function decodeEntries(raw: RawMap, root = ''): SourceMapEntry[] {
  if (!raw.sections) {
    return decodeMappings(raw.mappings ?? '', raw, root)
  }
  return raw.sections.flatMap(({ offset, map }) => decodeEntries(map, sectionRoot(map, root)).map(entry => ({
    ...entry,
    generatedLine: entry.generatedLine + offset.line,
    generatedColumn: entry.generatedColumn + (entry.generatedLine === 0 ? offset.column : 0),
  })))
}

interface Sources {
  contents: Map<string, string>
  ignored: Set<string>
}

function collectSources(raw: RawMap, root: string, into: Sources): Sources {
  if (raw.sections) {
    for (const { map } of raw.sections) {
      collectSources(map, sectionRoot(map, root), into)
    }
    return into
  }
  const ignoreList = raw.ignoreList ?? raw.x_google_ignoreList
  for (const [index, source] of (raw.sources ?? []).entries()) {
    if (typeof source !== 'string') {
      continue
    }
    const name = `${root}${source}`
    const content = raw.sourcesContent?.[index]
    if (typeof content === 'string' && content && !into.contents.has(name)) {
      into.contents.set(name, content)
    }
    if (ignoreList?.includes(index)) {
      into.ignored.add(name)
    }
  }
  return into
}

export function decodeSourceMap(raw: RawMap): SourceMapLookup {
  const entries = decodeEntries(raw).sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn)
  let sources: Sources | undefined
  const collected = () => sources ??= collectSources(raw, '', { contents: new Map(), ignored: new Set() })
  return {
    sourceContent: source => collected().contents.get(source),
    ignoredSource: source => collected().ignored.has(source),
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

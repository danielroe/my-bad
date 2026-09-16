import type { Frame, SourceLoader } from '../types'
import { readFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { dirname, isFilePath, resolvePath, toPath, withoutQuery } from '../report/path'

export interface RawSourceMap {
  version?: number
  mappings: string
  sources: (string | null)[]
  sourceRoot?: string
  names?: string[]
  file?: string
  /** Indices into `sources` that tooling marks as third-party or generated. */
  x_google_ignoreList?: number[]
  ignoreList?: number[]
}

export interface SourceMapLoaderOptions {
  /**
   * Return the raw sourcemap for a generated file, or a falsy value when the
   * file is unknown. Used to map frames from in-memory transforms (module
   * runners, `vm` evaluation) where no map is reachable from disk.
   */
  getSourceMap: (file: string) => RawSourceMap | undefined | null | Promise<RawSourceMap | undefined | null>
  /** Return the generated code for a file, so the compiled snippet can be shown. */
  getCode?: (file: string) => string | undefined | null | Promise<string | undefined | null>
  /** Read original sources from disk for snippets. Default `true`. */
  fs?: boolean
  /** Directory relative sources in the map resolve against. Defaults to the generated file's directory. */
  base?: (file: string) => string
  /**
   * Return a token that changes when the map for `file` changes, such as mtime
   * and size for a map on disk. Maps are cached while the token is unchanged;
   * without this option `getSourceMap` is consulted on every lookup.
   */
  getVersion?: (file: string) => string | undefined | Promise<string | undefined>
}

export interface MappedPosition {
  file: string
  line: number
  column: number
  /** The map flags this source as third-party or generated code. */
  ignored?: boolean
}

/**
 * Look up a 1-based generated position in a map. Returns `undefined` unless the
 * map has a segment on that exact generated line: `SourceMap.findEntry` falls
 * back to the nearest preceding segment, which would map an already-original
 * position a second time.
 */
export function findOriginal(map: SourceMap, line: number, column: number | undefined): { source: string, line: number, column: number } | undefined {
  const entry = map.findEntry(line - 1, column === undefined ? 0 : Math.max(0, column - 1))
  if (!('originalSource' in entry) || entry.originalSource === undefined || entry.originalLine === undefined || entry.generatedLine !== line - 1) {
    return
  }
  return { source: entry.originalSource, line: entry.originalLine + 1, column: (entry.originalColumn ?? 0) + 1 }
}

/** Resolve a 1-based generated position through a map to an original file position. */
export function mapPosition(map: SourceMap, raw: Pick<RawSourceMap, 'sourceRoot' | 'sources' | 'x_google_ignoreList' | 'ignoreList'>, base: string, line: number, column: number | undefined): MappedPosition | undefined {
  const original = findOriginal(map, line, column)
  if (!original) {
    return
  }
  const root = raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') : ''
  const ignoreList = raw.ignoreList ?? raw.x_google_ignoreList
  const index = raw.sources?.indexOf(original.source) ?? -1
  return {
    file: resolvePath(base, toPath(`${root}${original.source}`)),
    line: original.line,
    column: original.column,
    ...(index >= 0 && ignoreList?.includes(index) && { ignored: true }),
  }
}

interface Loaded {
  map: SourceMap
  raw: RawSourceMap
  base: string
}

/** Maps frames with sourcemaps supplied by the caller, and reads original sources from disk. */
export function sourceMapLoader(options: SourceMapLoaderOptions): SourceLoader {
  const cache = new Map<string, { version: string | undefined, value: Promise<Loaded | undefined> }>()
  const parsed = new WeakMap<RawSourceMap, SourceMap | null>()

  function parseMap(raw: RawSourceMap): SourceMap | undefined {
    const existing = parsed.get(raw)
    if (existing !== undefined) {
      return existing ?? undefined
    }
    try {
      const map = new SourceMap(raw as ConstructorParameters<typeof SourceMap>[0])
      parsed.set(raw, map)
      return map
    }
    catch {
      parsed.set(raw, null)
    }
  }

  async function load(file: string): Promise<Loaded | undefined> {
    const raw = await options.getSourceMap(file)
    if (!raw?.mappings) {
      return
    }
    const map = parseMap(raw)
    if (!map) {
      return
    }
    return { map, raw, base: options.base?.(file) ?? dirname(file) }
  }

  async function loaded(file: string): Promise<Loaded | undefined> {
    if (!options.getVersion) {
      return load(file)
    }
    const version = await options.getVersion(file)
    const entry = cache.get(file)
    if (entry && entry.version === version) {
      return entry.value
    }
    const value = load(file)
    cache.set(file, { version, value })
    return value
  }

  return {
    name: 'sourcemap',
    async map(frame: Frame) {
      if (!frame.file || frame.line === undefined) {
        return
      }
      const file = withoutQuery(frame.file)
      const result = await loaded(file)
      if (!result) {
        return
      }
      const mapped = mapPosition(result.map, result.raw, result.base, frame.line, frame.column)
      if (!mapped) {
        return
      }
      const { ignored, ...position } = mapped
      return {
        ...frame,
        ...position,
        ...(ignored && { type: 'vendor' as const }),
        compiled: frame.compiled ?? { file: frame.file, line: frame.line, column: frame.column },
      }
    },
    read(file: string) {
      const path = withoutQuery(file)
      if (options.fs === false || !isFilePath(path)) {
        return
      }
      return readFile(path, 'utf8').catch(() => undefined)
    },
    async readCompiled(file: string) {
      const code = await options.getCode?.(withoutQuery(file))
      return code ?? undefined
    },
  }
}

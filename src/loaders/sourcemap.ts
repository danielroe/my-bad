import type { Frame, SourceLoader } from '../types'
import type { SourceMapLookup } from './decode'
import { readFile } from 'node:fs/promises'
import { dirname, isFilePath, resolvePath, toPath, withoutQuery } from '../report/path'
import { decodeSourceMap } from './decode'
import { withEmbeddedSource } from './embedded'

export interface RawSourceMap {
  version?: number
  mappings: string
  sources: (string | null)[]
  /** Original contents per entry of `sources`, used for snippets in place of reading the file. */
  sourcesContent?: (string | null)[]
  sourceRoot?: string
  names?: string[]
  file?: string
  /** Indices into `sources` that tooling marks as third-party or generated. */
  x_google_ignoreList?: number[]
  ignoreList?: number[]
}

/** A map made of sections, each mapping the generated code from `offset` on. */
export interface RawIndexSourceMap {
  version?: number
  file?: string
  sections: Array<{ offset: { line: number, column: number }, map: RawSourceMap }>
}

export interface SourceMapLoaderOptions {
  /**
   * Return the raw sourcemap for a generated file, or a falsy value when the
   * file is unknown. Used to map frames from in-memory transforms (module
   * runners, `vm` evaluation) where no map is reachable from disk.
   */
  getSourceMap: (file: string) => RawSourceMap | RawIndexSourceMap | undefined | null | Promise<RawSourceMap | RawIndexSourceMap | undefined | null>
  /** Return the generated code for a file, so the compiled snippet can be shown. */
  getCode?: (file: string) => string | undefined | null | Promise<string | undefined | null>
  /** Read original sources from disk for snippets. Default `true`. */
  fs?: boolean
  /**
   * Use the map's `sourcesContent` for snippets, without reading the source.
   * Pass a function to decide per resolved source path. Default `true`.
   */
  sourcesContent?: boolean | ((file: string) => boolean)
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
 * map has a segment on that exact generated line: `findEntry` falls
 * back to the nearest preceding segment, which would map an already-original
 * position a second time.
 */
export function findOriginal(map: SourceMapLookup, line: number, column: number | undefined): { source: string, line: number, column: number } | undefined {
  const entry = map.findEntry(line - 1, column === undefined ? 0 : Math.max(0, column - 1))
  if (!('originalSource' in entry) || entry.originalSource === undefined || entry.originalLine === undefined || entry.generatedLine !== line - 1) {
    return
  }
  return { source: entry.originalSource, line: entry.originalLine + 1, column: (entry.originalColumn ?? 0) + 1 }
}

type SourceFields = Partial<Pick<RawSourceMap, 'sourceRoot' | 'sources' | 'sourcesContent' | 'x_google_ignoreList' | 'ignoreList'>>

/** Resolve a 1-based generated position through a map to an original file position. */
export function mapPosition(map: SourceMapLookup, raw: Pick<RawSourceMap, 'sourceRoot' | 'sources' | 'x_google_ignoreList' | 'ignoreList'>, base: string, line: number, column: number | undefined): MappedPosition | undefined {
  return resolveOriginal(map, raw, base, line, column)?.position
}

function resolveOriginal(map: SourceMapLookup, raw: SourceFields, base: string, line: number, column: number | undefined): { position: MappedPosition, source: string, index: number } | undefined {
  const original = findOriginal(map, line, column)
  if (!original) {
    return
  }
  const root = raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') : ''
  const ignoreList = raw.ignoreList ?? raw.x_google_ignoreList
  const index = raw.sources?.indexOf(original.source) ?? -1
  const ignored = index >= 0 ? ignoreList?.includes(index) : map.ignoredSource?.(original.source)
  return {
    position: {
      file: resolvePath(base, toPath(`${root}${original.source}`)),
      line: original.line,
      column: original.column,
      ...(ignored && { ignored: true }),
    },
    source: original.source,
    index,
  }
}

/** The contents a map embeds for one of its sources, ignoring empty placeholders. */
function embeddedContent(map: SourceMapLookup, raw: Pick<RawSourceMap, 'sourcesContent'>, source: string, index: number): string | undefined {
  const content = map.sourceContent ? map.sourceContent(source) : index >= 0 ? raw.sourcesContent?.[index] : undefined
  return typeof content === 'string' && content ? content : undefined
}

interface Loaded {
  map: SourceMapLookup
  /** Top-level source fields; an index map keeps them per section, where the decoded map reads them. */
  raw: SourceFields
  base: string
}

/** Decoded maps by raw map object, shared by every loader instance since integrations commonly create loaders per request. */
const parsed = new WeakMap<RawSourceMap | RawIndexSourceMap, SourceMapLookup | null>()

function parseMap(raw: RawSourceMap | RawIndexSourceMap): SourceMapLookup | undefined {
  const existing = parsed.get(raw)
  if (existing !== undefined) {
    return existing ?? undefined
  }
  try {
    const map = decodeSourceMap(raw)
    parsed.set(raw, map)
    return map
  }
  catch {
    parsed.set(raw, null)
  }
}

/**
 * Maps frames with sourcemaps supplied by the caller. Snippets come from the
 * map's `sourcesContent` where it has them, otherwise from disk.
 */
export function sourceMapLoader(options: SourceMapLoaderOptions): SourceLoader {
  const embed = options.sourcesContent ?? true
  const cache = new Map<string, { version: string | undefined, value: Promise<Loaded | undefined> }>()

  async function load(file: string): Promise<Loaded | undefined> {
    const raw = await options.getSourceMap(file)
    if (!raw || ('sections' in raw ? !Array.isArray(raw.sections) || !raw.sections.length : !raw.mappings)) {
      return
    }
    const map = parseMap(raw)
    if (!map) {
      return
    }
    return { map, raw: 'sections' in raw ? {} : raw, base: options.base?.(file) ?? dirname(file) }
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
      const resolved = resolveOriginal(result.map, result.raw, result.base, frame.line, frame.column)
      if (!resolved) {
        return
      }
      const { ignored, ...position } = resolved.position
      const mapped: Frame = {
        ...frame,
        ...position,
        ...(ignored && { type: 'vendor' as const }),
        compiled: frame.compiled ?? { file: frame.file, line: frame.line, column: frame.column },
      }
      const usable = typeof embed === 'function' ? embed(position.file) : embed
      return usable ? withEmbeddedSource(mapped, embeddedContent(result.map, result.raw, resolved.source, resolved.index)) : mapped
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

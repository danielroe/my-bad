import type { ModuleGraph, ModuleNode, ViteDevServer } from 'vite'
import type { SourceMapLookup } from '../loaders/decode'
import type { Frame, SourceLoader } from '../types'
import { readFile } from 'node:fs/promises'
import { decodeSourceMap } from '../loaders/decode'
import { withEmbeddedSource } from '../loaders/embedded'
import { parseInlineSourceMap } from '../loaders/fs'
import { findOriginal } from '../loaders/sourcemap'
import { dirname, isFilePath, normalizeSlashes, resolvePath, toPath, withoutQuery } from '../report/path'

interface AnyModuleGraph {
  getModulesByFile: (file: string) => Set<ModuleNode> | undefined
  getModuleById: (id: string) => ModuleNode | undefined
  idToModuleMap?: Map<string, ModuleNode>
}

function graphs(server: ViteDevServer): AnyModuleGraph[] {
  const environments = (server as unknown as { environments?: Record<string, { moduleGraph: ModuleGraph }> }).environments
  if (environments) {
    return Object.values(environments).map(env => env.moduleGraph as unknown as AnyModuleGraph)
  }
  return [server.moduleGraph as unknown as AnyModuleGraph]
}

function findModule(server: ViteDevServer, file: string): ModuleNode | undefined {
  const normalized = normalizeSlashes(file)
  for (const graph of graphs(server)) {
    const byFile = graph.getModulesByFile(normalized)
    if (byFile?.size) {
      return [...byFile].find(mod => mod.ssrTransformResult ?? mod.transformResult) ?? [...byFile][0]
    }
    const byId = graph.getModuleById(normalized) ?? graph.getModuleById(`\0${normalized}`)
    if (byId) {
      return byId
    }
  }
}

type TransformResult = NonNullable<ModuleNode['transformResult']>

interface DecodedMap {
  code: string
  map: TransformResult['map']
  lookup: SourceMapLookup | undefined
  /** The map's `sourceRoot`, with a trailing `/`. */
  root: string
}

/**
 * Decoded maps by transform result, shared by every loader instance. The module
 * runner rewrites `code` in place to append its inline map, so an entry is only
 * reused while `code` and `map` are the ones it was decoded from.
 */
const decoded = new WeakMap<TransformResult, DecodedMap>()

/**
 * The map embedded in the transformed code accounts for the module runner's
 * wrapper lines, so it matches runtime stack positions where `transformResult.map`
 * does not. Prefer it when present.
 */
function decode(result: TransformResult): DecodedMap {
  const entry: DecodedMap = { code: result.code, map: result.map, lookup: undefined, root: '' }
  const raw = (parseInlineSourceMap(result.code) ?? result.map) as { mappings?: string, sections?: unknown[], sourceRoot?: string } | null | undefined
  if (!raw?.mappings && !(Array.isArray(raw?.sections) && raw.sections.length)) {
    return entry
  }
  try {
    entry.lookup = decodeSourceMap(raw as Parameters<typeof decodeSourceMap>[0])
    entry.root = typeof raw.sourceRoot === 'string' && raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') : ''
  }
  catch {}
  return entry
}

function mapOf(mod: ModuleNode): { map: SourceMapLookup, root: string, base: string } | undefined {
  const result = mod.ssrTransformResult ?? mod.transformResult
  if (!result) {
    return
  }
  let entry = decoded.get(result)
  if (!entry || entry.code !== result.code || entry.map !== result.map) {
    entry = decode(result)
    decoded.set(result, entry)
  }
  return entry.lookup && { map: entry.lookup, root: entry.root, base: dirname(mod.file ?? mod.id ?? '/') }
}

export interface ViteLoaderOptions {
  /** Fall back to reading files from disk. Default `true`. */
  fs?: boolean
}

/**
 * Maps frames through Vite's module graph (SSR or client transforms). Snippets
 * come from the map's `sourcesContent`, then from disk or, for virtual modules,
 * from the transformed code.
 */
export function viteLoader(server: ViteDevServer, options: ViteLoaderOptions = {}): SourceLoader {
  return {
    name: 'vite',
    map(frame: Frame) {
      if (!frame.file || frame.line === undefined) {
        return
      }
      const mod = findModule(server, frame.file)
      if (!mod) {
        return
      }
      const loaded = mapOf(mod)
      if (!loaded) {
        return
      }
      const original = findOriginal(loaded.map, frame.line, frame.column)
      if (!original) {
        return
      }
      const { source, line, column } = original
      const named = `${loaded.root}${source}`
      const file = isFilePath(named) || named.startsWith('file:') ? toPath(named) : named.startsWith('/@fs/') ? named.slice(4) : /^[^./]/.test(named) && !named.includes(':') ? mod.file ?? frame.file : resolvePath(loaded.base, named)
      const content = loaded.map.sourceContent?.(source)
      if (withoutQuery(file) === withoutQuery(frame.file) && line === frame.line && column === frame.column) {
        // Already original: left unmapped, but the map's copy of the source still serves its snippet.
        withEmbeddedSource(frame, content)
        return
      }
      return withEmbeddedSource({
        ...frame,
        file,
        line,
        column,
        compiled: frame.compiled ?? { file: frame.file, line: frame.line, column: frame.column },
      }, content)
    },
    readCompiled(file: string) {
      const mod = findModule(server, file)
      return (mod?.ssrTransformResult ?? mod?.transformResult)?.code ?? undefined
    },
    async read(file: string) {
      const mod = findModule(server, file)
      const virtual = mod && !mod.file
      if (virtual) {
        return (mod.ssrTransformResult ?? mod.transformResult)?.code ?? undefined
      }
      if (options.fs === false || !isFilePath(file)) {
        return
      }
      return readFile(withoutQuery(file), 'utf8').catch(() => undefined)
    },
  }
}

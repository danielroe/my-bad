import type { ModuleGraph, ModuleNode, ViteDevServer } from 'vite'
import type { Frame, SourceLoader } from '../types'
import { readFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
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

/**
 * The map embedded in the transformed code accounts for the module runner's
 * wrapper lines, so it matches runtime stack positions where `transformResult.map`
 * does not. Prefer it when present.
 */
function mapOf(mod: ModuleNode): { map: SourceMap, base: string } | undefined {
  const result = mod.ssrTransformResult ?? mod.transformResult
  if (!result) {
    return
  }
  const raw = parseInlineSourceMap(result.code) ?? (result.map as { mappings?: string } | null | undefined)
  if (!raw?.mappings) {
    return
  }
  try {
    return { map: new SourceMap(raw as ConstructorParameters<typeof SourceMap>[0]), base: dirname(mod.file ?? mod.id ?? '/') }
  }
  catch {}
}

export interface ViteLoaderOptions {
  /** Fall back to reading files from disk. Default `true`. */
  fs?: boolean
}

/**
 * Maps frames through Vite's module graph (SSR or client transforms) and reads
 * sources from disk or, for virtual modules, from the transformed code.
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
      const file = isFilePath(source) || source.startsWith('file:') ? toPath(source) : source.startsWith('/@fs/') ? source.slice(4) : /^[^./]/.test(source) && !source.includes(':') ? mod.file ?? frame.file : resolvePath(loaded.base, source)
      if (withoutQuery(file) === withoutQuery(frame.file) && line === frame.line && column === frame.column) {
        return
      }
      return {
        ...frame,
        file,
        line,
        column,
        compiled: frame.compiled ?? { file: frame.file, line: frame.line, column: frame.column },
      }
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

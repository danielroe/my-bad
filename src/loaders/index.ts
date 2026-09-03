import type { SourceLoader } from '../types'
import { fsLoader } from './fs'

export { fsLoader, parseInlineSourceMap } from './fs'
export type { FsLoaderOptions } from './fs'
export { mapPosition, sourceMapLoader } from './sourcemap'
export type { MappedPosition, RawSourceMap, SourceMapLoaderOptions } from './sourcemap'

/** Reads sources from disk without mapping, for processes started with `--enable-source-maps`. */
export function passthroughLoader(): SourceLoader {
  return { ...fsLoader({ sidecar: false, inline: false }), name: 'passthrough' }
}

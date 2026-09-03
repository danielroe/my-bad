import type { SourceLoader } from '../types'
import type { RawSourceMap } from './sourcemap'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { dirname, resolvePath } from '../report/path'
import { sourceMapLoader } from './sourcemap'

const SOURCE_MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/
/** The comment can only be in the tail of a file. */
const TAIL = 8192

export interface FsLoaderOptions {
  /** Look for `<file>.map` sidecars. Default `true`. */
  sidecar?: boolean
  /** Parse `sourceMappingURL` comments. Default `true`. */
  inline?: boolean
}

/** Decode a `sourceMappingURL=data:` payload. */
export function parseDataUrl(url: string): string | undefined {
  if (!url.startsWith('data:')) {
    return
  }
  const comma = url.indexOf(',')
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  return meta.includes(';base64') ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data)
}

/**
 * Decode the `sourceMappingURL=data:` comment of a module's transformed code,
 * for module runners that expose the code but not the parsed map.
 */
export function parseInlineSourceMap(code: string): RawSourceMap | undefined {
  const url = SOURCE_MAPPING_URL_RE.exec(code.slice(-TAIL))?.[1]
  const data = url ? parseDataUrl(url) : undefined
  return data === undefined ? undefined : parse(data)
}

/**
 * Maps frames through `.map` sidecars or `sourceMappingURL` comments and reads
 * sources from disk. Node-only.
 */
export function fsLoader(options: FsLoaderOptions = {}): SourceLoader {
  const { sidecar = true, inline = true } = options
  const bases = new Map<string, string>()

  async function getSourceMap(file: string): Promise<RawSourceMap | undefined> {
    const sidecarRaw = sidecar ? await readFile(`${file}.map`, 'utf8').catch(() => undefined) : undefined
    if (sidecarRaw) {
      return parse(sidecarRaw)
    }
    if (!inline) {
      return
    }
    const contents = await readFile(file, 'utf8').catch(() => undefined)
    const url = contents ? SOURCE_MAPPING_URL_RE.exec(contents.slice(-TAIL))?.[1] : undefined
    if (!url) {
      return
    }
    const data = parseDataUrl(url)
    if (data !== undefined) {
      return parse(data)
    }
    const mapPath = resolvePath(dirname(file), url)
    const linked = await readFile(mapPath, 'utf8').catch(() => undefined)
    if (linked) {
      bases.set(file, dirname(mapPath))
      return parse(linked)
    }
  }

  const loader = sourceMapLoader({ getSourceMap, base: file => bases.get(file) ?? dirname(file) })
  return {
    ...loader,
    name: 'fs',
    readCompiled: file => loader.read!(file),
  }
}

function parse(raw: string): RawSourceMap | undefined {
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

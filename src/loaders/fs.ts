import type { SourceLoader } from '../types'
import type { RawSourceMap } from './sourcemap'
import { Buffer } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolvePath } from '../report/path'
import { sourceMapLoader } from './sourcemap'

const SOURCE_MAPPING_URL_MARKER = 'sourceMappingURL='
const SOURCE_MAPPING_URL_PREFIX_RE = /\/\/[#@][^\S\n]*$/
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

function lastSourceMappingURL(tail: string): string | undefined {
  const at = tail.lastIndexOf(SOURCE_MAPPING_URL_MARKER)
  if (at < 0 || !SOURCE_MAPPING_URL_PREFIX_RE.test(tail.slice(0, at))) {
    return
  }
  const url = tail.slice(at + SOURCE_MAPPING_URL_MARKER.length).trimEnd()
  return url && !/\s/.test(url) ? url : undefined
}

/**
 * Decode the `sourceMappingURL=data:` comment of a module's transformed code,
 * for module runners that expose the code but not the parsed map.
 */
export function parseInlineSourceMap(code: string): RawSourceMap | undefined {
  const url = lastSourceMappingURL(code.slice(-TAIL))
  const data = url ? parseDataUrl(url) : undefined
  return data === undefined ? undefined : parse(data)
}

/**
 * Maps frames through `.map` sidecars or `sourceMappingURL` comments and reads
 * sources from disk. Node-only.
 */
export function fsLoader(options: FsLoaderOptions = {}): SourceLoader {
  const { sidecar = true, inline = true } = options
  const linked = new Map<string, string>()

  async function stamp(path: string): Promise<string> {
    const stats = await stat(path).catch(() => undefined)
    return stats ? `${stats.mtimeMs}:${stats.size}` : '-'
  }

  async function getVersion(file: string): Promise<string> {
    const paths = [...(sidecar ? [`${file}.map`] : []), ...(inline ? [file] : []), ...(linked.has(file) ? [linked.get(file)!] : [])]
    return (await Promise.all(paths.map(stamp))).join('|')
  }

  async function getSourceMap(file: string): Promise<RawSourceMap | undefined> {
    linked.delete(file)
    const sidecarRaw = sidecar ? await readFile(`${file}.map`, 'utf8').catch(() => undefined) : undefined
    if (sidecarRaw) {
      return parse(sidecarRaw)
    }
    if (!inline) {
      return
    }
    const contents = await readFile(file, 'utf8').catch(() => undefined)
    const url = contents ? lastSourceMappingURL(contents.slice(-TAIL)) : undefined
    if (!url) {
      return
    }
    const data = parseDataUrl(url)
    if (data !== undefined) {
      return parse(data)
    }
    const mapPath = resolvePath(dirname(file), url)
    const linkedRaw = await readFile(mapPath, 'utf8').catch(() => undefined)
    linked.set(file, mapPath)
    if (linkedRaw) {
      return parse(linkedRaw)
    }
  }

  const loader = sourceMapLoader({ getSourceMap, getVersion, base: file => dirname(linked.get(file) ?? file) })
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

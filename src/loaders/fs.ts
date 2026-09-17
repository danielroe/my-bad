import type { Stats } from 'node:fs'
import type { SourceLoader } from '../types'
import type { RawSourceMap } from './sourcemap'
import { Buffer } from 'node:buffer'
import { realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isFilePath, resolvePath, withoutQuery } from '../report/path'
import { sourceMapLoader } from './sourcemap'

const SOURCE_MAPPING_URL_MARKER = 'sourceMappingURL='
const SOURCE_MAPPING_URL_PREFIX_RE = /\/\/[#@][^\S\n]*$/
/** Trailing bytes scanned when the comment is not on the final line. */
const TAIL = 8192

export interface FsLoaderOptions {
  /** Look for `<file>.map` sidecars. Default `true`. */
  sidecar?: boolean
  /** Parse `sourceMappingURL` comments. Default `true`. */
  inline?: boolean
  /** Directories the loader may read from, maps included. Paths are canonicalised, so a symlink out of a root is denied. Unrestricted by default. */
  roots?: string[]
  /** Further per-file check, applied after `roots`. */
  canRead?: (file: string) => boolean
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

function sourceMappingURLIn(tail: string): string | undefined {
  const at = tail.lastIndexOf(SOURCE_MAPPING_URL_MARKER)
  if (at < 0 || !SOURCE_MAPPING_URL_PREFIX_RE.test(tail.slice(0, at))) {
    return
  }
  const url = tail.slice(at + SOURCE_MAPPING_URL_MARKER.length).trimEnd()
  return url && !/\s/.test(url) ? url : undefined
}

/**
 * The comment is normally the final line, which for an inline map can be far
 * longer than any fixed tail window, so that line is checked first.
 */
function lastSourceMappingURL(code: string): string | undefined {
  let end = code.length
  while (end > 0 && (code.charCodeAt(end - 1) === 10 || code.charCodeAt(end - 1) === 13)) {
    end--
  }
  const start = code.lastIndexOf('\n', end - 1) + 1
  return sourceMappingURLIn(code.slice(start, end)) ?? sourceMappingURLIn(code.slice(-TAIL))
}

/**
 * Decode the `sourceMappingURL=data:` comment of a module's transformed code,
 * for module runners that expose the code but not the parsed map.
 */
export function parseInlineSourceMap(code: string): RawSourceMap | undefined {
  const url = lastSourceMappingURL(code)
  const data = url ? parseDataUrl(url) : undefined
  return data === undefined ? undefined : parse(data)
}

/**
 * Contents keyed by size and mtime, shared by every loader instance: integrations
 * commonly create loaders per request, and validation against `stat` keeps a
 * shared cache correct after a rebuild.
 */
const files = new Map<string, CachedFile>()
const MAX_FILES = 64

/** Lookups made in the same event-loop turn (the frames of one stack) share a single `stat`. */
let turn: Map<string, Promise<CachedFile | undefined>> | undefined

function read(path: string): Promise<CachedFile | undefined> {
  if (!turn) {
    turn = new Map()
    setImmediate(() => {
      turn = undefined
    })
  }
  let pending = turn.get(path)
  if (!pending) {
    pending = readFresh(path)
    turn.set(path, pending)
  }
  return pending
}

async function readFresh(path: string): Promise<CachedFile | undefined> {
  const info = statOrUndefined(path)
  if (!info?.isFile()) {
    files.delete(path)
    return
  }
  const cached = files.get(path)
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached
  }
  const contents = await readFile(path, 'utf8').catch(() => undefined)
  if (contents === undefined) {
    files.delete(path)
    return
  }
  const entry: CachedFile = { size: info.size, mtimeMs: info.mtimeMs, contents }
  files.delete(path)
  if (files.size >= MAX_FILES) {
    files.delete(files.keys().next().value!)
  }
  files.set(path, entry)
  return entry
}

/**
 * Maps frames through `.map` sidecars or `sourceMappingURL` comments and reads
 * sources from disk. Node-only.
 */
export function fsLoader(options: FsLoaderOptions = {}): SourceLoader {
  const { sidecar = true, inline = true, roots, canRead } = options
  const linked = new Map<string, string>()
  const bounds = roots?.map(root => canonicalPath(root).replace(/\/$/, ''))

  /** The canonical path to read, or `undefined` when it is out of bounds. */
  function allowed(path: string): string | undefined {
    let target = path
    if (bounds) {
      target = canonicalPath(path)
      if (!bounds.some(root => target === root || target.startsWith(`${root}/`))) {
        return
      }
    }
    return canRead && !canRead(path) ? undefined : target
  }

  const readAllowed = (path: string) => {
    const target = allowed(path)
    return target === undefined ? Promise.resolve(undefined) : read(target)
  }

  async function getSourceMap(file: string): Promise<RawSourceMap | undefined> {
    linked.delete(file)
    if (allowed(file) === undefined) {
      return
    }
    const sidecarFile = sidecar ? await readAllowed(`${file}.map`) : undefined
    if (sidecarFile) {
      return parsed(sidecarFile)
    }
    if (!inline) {
      return
    }
    const source = await readAllowed(file)
    if (!source) {
      return
    }
    source.url ??= lastSourceMappingURL(source.contents) ?? null
    const url = source.url
    if (!url) {
      return
    }
    if (url.startsWith('data:')) {
      return parsed(source, url)
    }
    const mapPath = resolvePath(dirname(file), url)
    const linkedFile = await readAllowed(mapPath)
    linked.set(file, mapPath)
    if (linkedFile) {
      return parsed(linkedFile)
    }
  }

  const loader = sourceMapLoader({ getSourceMap, base: file => dirname(linked.get(file) ?? file) })
  const readContents = async (file: string) => {
    const path = withoutQuery(file)
    return isFilePath(path) ? (await readAllowed(path))?.contents : undefined
  }
  return {
    ...loader,
    name: 'fs',
    read: readContents,
    readCompiled: readContents,
  }
}

/** Lexical containment can be escaped through a symlink, so roots and candidates are compared as real paths. */
function canonicalPath(path: string): string {
  try {
    return normalizePath(realpathSync(path))
  }
  catch {}
  const normalized = normalizePath(path)
  const parent = dirname(normalized)
  if (parent === normalized || parent === '.') {
    return normalized
  }
  const base = canonicalPath(parent)
  return `${base === '/' ? '' : base}/${normalized.split('/').pop()}`
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const segments: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '..') {
      segments.pop()
    }
    else if (part !== '.' && part !== '') {
      segments.push(part)
    }
  }
  return `${normalized.startsWith('/') ? '/' : ''}${segments.join('/')}`
}

/**
 * A synchronous `stat` on the page cache costs a few microseconds, whereas the
 * promise-based one materialises an exception for every missing sidecar.
 */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false })
  }
  catch {
    return undefined
  }
}

interface CachedFile {
  size: number
  mtimeMs: number
  contents: string
  /** Map decoded from these contents, or `null` once decoding has failed. */
  map?: RawSourceMap | null
  /** `sourceMappingURL` in these contents, or `null` when there is none. */
  url?: string | null
}

/** Decode a file's map once per version of its contents. */
function parsed(file: CachedFile, dataUrl?: string): RawSourceMap | undefined {
  if (file.map === undefined) {
    const data = dataUrl ? parseDataUrl(dataUrl) : file.contents
    file.map = (data === undefined ? undefined : parse(data)) ?? null
  }
  return file.map ?? undefined
}

function parse(raw: string): RawSourceMap | undefined {
  try {
    return JSON.parse(raw)
  }
  catch {
    return undefined
  }
}

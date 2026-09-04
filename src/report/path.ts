const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_DRIVE_RE = /^\/?[a-z]:[\\/]/i

/** Convert a `file:` URL to a filesystem path. Other inputs are returned unchanged. */
export function toPath(source: string): string {
  if (!source.startsWith('file:')) {
    return source
  }
  let rest = source.slice(5).replace(/^\/\//, '')
  if (rest.startsWith('/')) {
    rest = safeDecode(rest)
    return WINDOWS_DRIVE_RE.test(rest) ? rest.slice(1) : rest
  }
  return `//${safeDecode(rest)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

export function hasScheme(source: string): boolean {
  return SCHEME_RE.test(source) && !WINDOWS_DRIVE_RE.test(`/${source}`)
}

export function isFilePath(source: string): boolean {
  return source.startsWith('/') || WINDOWS_DRIVE_RE.test(`/${source}`) || source.startsWith('\\\\')
}

/** Drop cache-busting query params but keep semantically meaningful ones. */
export function stripCacheQuery(source: string): string {
  const index = source.indexOf('?')
  if (index === -1) {
    return source
  }
  const params = source.slice(index + 1).split('&').filter(param => !/^(?:t|v|import)(?:=|$)/.test(param))
  return params.length ? `${source.slice(0, index)}?${params.join('&')}` : source.slice(0, index)
}

export function withoutQuery(source: string): string {
  const index = source.indexOf('?')
  return index === -1 ? source : source.slice(0, index)
}

export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

export function relativeToCwd(file: string, cwd: string): string {
  const normalizedCwd = normalizeSlashes(cwd).replace(/\/$/, '')
  const normalizedFile = normalizeSlashes(file)
  if (normalizedFile === normalizedCwd) {
    return '.'
  }
  if (normalizedFile.startsWith(`${normalizedCwd}/`)) {
    return `./${normalizedFile.slice(normalizedCwd.length + 1)}`
  }
  return file
}

export interface DisplayTarget {
  file?: string
  displayFile?: string
}

/**
 * Path as shown to the user: the `displayFile` resolved when the report was
 * built, else relative to `cwd`, or the part after the last `node_modules/`.
 */
export function displayPath(target: string | DisplayTarget, cwd?: string): string {
  if (typeof target !== 'string') {
    return target.displayFile ?? (target.file ? displayPath(target.file, cwd) : '')
  }
  const file = target
  const normalized = normalizeSlashes(file)
  const index = normalized.lastIndexOf('/node_modules/')
  if (index !== -1) {
    return `…/${normalized.slice(index + '/node_modules/'.length)}`
  }
  return cwd ? relativeToCwd(file, cwd).replace(/^\.\//, '') : file
}

export function dirname(path: string): string {
  const normalized = normalizeSlashes(path)
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? (index === 0 ? '/' : '.') : normalized.slice(0, index)
}

export function resolvePath(base: string, target: string): string {
  if (hasScheme(target) || isFilePath(target)) {
    return toPath(target)
  }
  const segments = normalizeSlashes(base).split('/')
  for (const part of normalizeSlashes(target).split('/')) {
    if (part === '..') {
      segments.pop()
    }
    else if (part !== '.' && part !== '') {
      segments.push(part)
    }
  }
  return segments.join('/')
}

export function extname(path: string): string {
  const base = withoutQuery(normalizeSlashes(path)).split('/').pop() || ''
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

const LANGS: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  vue: 'vue',
  html: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  json: 'json',
  md: 'md',
}

export function langFromFile(file: string): string | undefined {
  return LANGS[extname(file)]
}

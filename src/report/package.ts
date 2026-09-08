import { existsSync, readFileSync } from 'node:fs'
import { dirname, isFilePath, normalizeSlashes, relativeToCwd } from './path'

export interface PackageInfo {
  /** Directory containing the `package.json`. */
  dir: string
  name: string
}

const cache = new Map<string, PackageInfo | undefined>()

const ROOT_RE = /^(?:\/|\.|[a-z]:\/?)?$/i

/** Nearest ancestor directory of `file` that contains a `package.json`, with that package's name. */
export function resolvePackage(file: string): PackageInfo | undefined {
  let dir = dirname(normalizeSlashes(file))
  const pending: string[] = []
  while (!ROOT_RE.test(dir)) {
    if (cache.has(dir)) {
      const cached = cache.get(dir)
      for (const key of pending) {
        cache.set(key, cached)
      }
      return cached
    }
    const info = readPackage(dir)
    if (info) {
      cache.set(dir, info)
      for (const key of pending) {
        cache.set(key, info)
      }
      return info
    }
    pending.push(dir)
    dir = dirname(dir)
  }
  for (const key of pending) {
    cache.set(key, undefined)
  }
}

function readPackage(dir: string): PackageInfo | undefined {
  const manifest = `${dir}/package.json`
  try {
    if (!existsSync(manifest)) {
      return
    }
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name
    return { dir, name: typeof name === 'string' && name ? name : dir.split('/').pop()! }
  }
  catch {
    return existsSync(manifest) ? { dir, name: dir.split('/').pop()! } : undefined
  }
}

export interface ExternalPackage extends PackageInfo {
  /** Path as shown to the user: `…/<package>/<path within the package>`. */
  displayFile: string
}

/**
 * Resolve the package a file outside `cwd` belongs to, so linked workspace
 * packages and `file:` dependencies render like `node_modules` paths instead of
 * as absolute paths, and can be classified by package name.
 */
export function externalPackage(file: string, cwd: string): ExternalPackage | undefined {
  const normalized = normalizeSlashes(file)
  if (!isFilePath(normalized) || normalized.includes('/node_modules/') || relativeToCwd(normalized, cwd) !== normalized) {
    return
  }
  const info = resolvePackage(normalized)
  if (!info || normalized.length <= info.dir.length + 1) {
    return
  }
  return { ...info, displayFile: `…/${info.name}/${normalized.slice(info.dir.length + 1)}` }
}

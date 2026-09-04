import type { Frame, FrameType } from '../types'
import { normalizeSlashes } from './path'

const VENDOR_RE = /\/(?:node_modules|\.pnpm|\.yarn|\.bun)\//
const NATIVE_RE = /^(?:node:|internal\/|<anonymous>|native$|wasm:|ext:|bun:|deno:)/

export function matchesPattern(value: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value)
}

/**
 * `pkg` is the name of the package the frame's file belongs to, when it is
 * outside `cwd`; patterns are matched against it so framework frames are
 * recognised wherever the package physically resolved from.
 */
export function classifyFrame(frame: Pick<Frame, 'file' | 'function' | 'line'> & { isNative?: boolean }, internal: (string | RegExp)[], pkg?: string): FrameType {
  if (frame.isNative || !frame.file) {
    return 'native'
  }
  const file = normalizeSlashes(frame.file)
  if (NATIVE_RE.test(file)) {
    return 'native'
  }
  for (const pattern of internal) {
    if (matchesPattern(file, pattern) || (frame.function && matchesPattern(frame.function, pattern)) || (pkg && matchesPattern(pkg, pattern))) {
      return 'internal'
    }
  }
  if (VENDOR_RE.test(file)) {
    return 'vendor'
  }
  return 'app'
}

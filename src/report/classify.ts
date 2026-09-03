import type { Frame, FrameType } from '../types'
import { normalizeSlashes } from './path'

const VENDOR_RE = /\/(?:node_modules|\.pnpm|\.yarn|\.bun)\//
const NATIVE_RE = /^(?:node:|internal\/|<anonymous>|native$|wasm:|ext:|bun:|deno:)/

export function matchesPattern(value: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value)
}

export function classifyFrame(frame: Pick<Frame, 'file' | 'function' | 'line'> & { isNative?: boolean }, internal: (string | RegExp)[]): FrameType {
  if (frame.isNative || !frame.file) {
    return 'native'
  }
  const file = normalizeSlashes(frame.file)
  if (NATIVE_RE.test(file)) {
    return 'native'
  }
  for (const pattern of internal) {
    if (matchesPattern(file, pattern) || (frame.function && matchesPattern(frame.function, pattern))) {
      return 'internal'
    }
  }
  if (VENDOR_RE.test(file)) {
    return 'vendor'
  }
  return 'app'
}

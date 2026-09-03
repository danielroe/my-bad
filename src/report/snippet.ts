import type { Snippet } from '../types'
import { langFromFile } from './path'

export function extractSnippet(contents: string, line: number, context: number, file?: string): Snippet | undefined {
  const lines = contents.split(/\r?\n/)
  if (line < 1 || line > lines.length) {
    return
  }
  const start = Math.max(1, line - context)
  const end = Math.min(lines.length, line + context)
  return {
    start,
    lines: lines.slice(start - 1, end),
    lang: file ? langFromFile(file) : undefined,
  }
}

/**
 * Parse a code frame in the format produced by Vite / Rollup / the Vue compiler,
 * where each line is `NN |  code` and the pointer line is `   |    ^`.
 */
export function parseCodeFrame(frame: string): Snippet | undefined {
  const lines: string[] = []
  let start: number | undefined
  for (const raw of frame.split('\n')) {
    const match = /^\s*(\d+)\s*\|\s{0,2}(.*)$/.exec(raw)
    if (match) {
      start ??= Number(match[1])
      lines.push(match[2] ?? '')
    }
  }
  return start === undefined ? undefined : { start, lines }
}

const FRAME_LINE_RE = /^(\s*(\d+)\s*\|\s{0,2})/
const CARET_LINE_RE = /^(\s*\|\s*)\^/

/** Recover the error location from a code frame, for compile errors that ship a frame but no `loc`. */
export function locFromCodeFrame(frame: string): { line: number, column: number } | undefined {
  let line: number | undefined
  let prefix = 0
  for (const raw of frame.split('\n')) {
    const numbered = FRAME_LINE_RE.exec(raw)
    if (numbered) {
      line = Number(numbered[2])
      prefix = numbered[1]!.length
      continue
    }
    const caret = CARET_LINE_RE.exec(raw)
    if (caret && line !== undefined) {
      return { line, column: Math.max(1, caret[1]!.length - prefix + 1) }
    }
  }
}

const LABELLED_FRAME_RE = /[\u2500\u252C\u256D\u250C\-]\[\s*([^\]\s]+?):(\d+):(\d+)\s*\]/

/** Position from an oxc / miette style frame header such as `╭─[ src/a.ts:2:24 ]`. */
export function locFromLabelledFrame(text: string): { file: string, line: number, column: number } | undefined {
  const match = LABELLED_FRAME_RE.exec(text)
  return match ? { file: match[1]!, line: Number(match[2]), column: Number(match[3]) } : undefined
}

/** Strip an embedded code frame (oxc / esbuild style) from a compiler message, keeping the prose. */
export function stripEmbeddedFrame(message: string): string {
  const lines = message.split('\n')
  const start = lines.findIndex(line => LABELLED_FRAME_RE.test(line) || /^\s*\d+\s*[│|]/.test(line))
  if (start <= 0) {
    return message
  }
  return lines.slice(0, start).join('\n').replace(/\s+$/, '')
}

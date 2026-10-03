import type { Snippet } from '../types'
import { langFromFile } from './path'
import { continuationAt } from './tokenize'

export interface SnippetBounds {
  /** 1-based column the snippet is about, kept inside the window when lines are cropped. */
  column?: number
  /** Maximum characters of each line. */
  maxLineLength?: number
}

export function extractSnippet(contents: string, line: number, context: number, file?: string, bounds: SnippetBounds = {}): Snippet | undefined {
  if (line < 1) {
    return
  }
  const start = Math.max(1, line - context)
  const ranges = rangesBetween(contents, start, line + context)
  if (ranges.length <= line - start) {
    return
  }
  const lang = file ? langFromFile(file) : undefined
  const max = bounds.maxLineLength ?? Infinity
  if (ranges.some(([from, to]) => to - from > max)) {
    const offset = windowStart(bounds.column, max)
    return { start, lines: ranges.map(([from, to]) => cropRange(contents, from, to, offset, max)), lang, offset }
  }
  const continues = continuationAt(contents, ranges[0]![0], lang)
  return {
    start,
    lines: ranges.map(([from, to]) => contents.slice(from, to)),
    lang,
    ...(continues && { continues }),
  }
}

/** Crop the lines of a snippet that was not read from a file, such as a compiler's code frame. */
export function cropSnippet(snippet: Snippet, column: number | undefined, max: number): Snippet {
  if (snippet.offset !== undefined || !snippet.lines.some(text => text.length > max)) {
    return snippet
  }
  const offset = windowStart(column, max)
  const { tokens: _, ...rest } = snippet
  return { ...rest, lines: snippet.lines.map(text => cropRange(text, 0, text.length, offset, max)), offset }
}

/** Where a window of `max` characters starts so that `column` stays clear of its edges. */
function windowStart(column: number | undefined, max: number): number {
  const index = column === undefined || !Number.isFinite(column) ? 0 : Math.max(0, Math.floor(column) - 1)
  return index < max - Math.floor(max / 4) ? 0 : index - Math.floor(max / 2)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/**
 * The window `[offset, offset + max)` of `text.slice(from, to)`. A cut end gives
 * up its last character to `…`, so every character keeps its column, and a
 * surrogate split by the cut becomes U+FFFD.
 */
function cropRange(text: string, from: number, to: number, offset: number, max: number): string {
  const length = to - from
  if (offset === 0 && length <= max) {
    return text.slice(from, to)
  }
  if (length <= offset) {
    return length > 0 ? '…' : ''
  }
  const end = Math.min(to, from + offset + max)
  let out = text.slice(from + offset, end)
  if (offset > 0) {
    out = `…${isLowSurrogate(out.charCodeAt(1)) ? '\uFFFD' : ''}${out.slice(isLowSurrogate(out.charCodeAt(1)) ? 2 : 1)}`
  }
  if (end < to) {
    const last = out.length - 2
    out = `${out.slice(0, isHighSurrogate(out.charCodeAt(last)) ? last : last + 1)}${isHighSurrogate(out.charCodeAt(last)) ? '\uFFFD' : ''}…`
  }
  return out
}

/** A single 1-based line, or `undefined` past the end of the file. */
export function lineAt(contents: string, line: number): string | undefined {
  if (line < 1) {
    return
  }
  const range = rangesBetween(contents, line, line)[0]
  return range && contents.slice(range[0], range[1])
}

/** Offsets of lines `from` to `to` (1-based, inclusive), without a trailing `\r` and without splitting the whole file. */
function rangesBetween(contents: string, from: number, to: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let offset = 0
  for (let n = 1; n <= to; n++) {
    const newline = contents.indexOf('\n', offset)
    const end = newline === -1 ? contents.length : newline
    if (n >= from) {
      ranges.push([offset, newline !== -1 && contents.charCodeAt(end - 1) === 13 ? end - 1 : end])
    }
    if (newline === -1) {
      break
    }
    offset = newline + 1
  }
  return ranges
}

const FRAME_LINE_RE = /^(\s*(\d+)\s*\|\s{0,2})(.*)$/
const CARET_LINE_RE = /^(\s*\|\s*)\^/
/** Rolldown / oxc render frames as `NN:  code` with no gutter character. */
const COLON_LINE_RE = /^(\s*(\d+):\s?)(.*)$/
const BARE_CARET_RE = /^(\s*)\^/

/**
 * `NN: code` lines are ambiguous with ordinary prose (`404: not found`), so they
 * only count as a frame when a caret line or a second numbered line confirms it.
 */
function colonFrameStart(lines: string[]): number | undefined {
  for (const [index, line] of lines.entries()) {
    if (!COLON_LINE_RE.test(line)) {
      continue
    }
    const next = lines[index + 1]
    if (next !== undefined && (COLON_LINE_RE.test(next) || (BARE_CARET_RE.test(next) && !CARET_LINE_RE.test(next)))) {
      return index
    }
  }
}

/**
 * Parse a code frame in the format produced by Vite / Rollup / the Vue compiler,
 * where each line is `NN |  code` and the pointer line is `   |    ^`, or the
 * rolldown / oxc variant where each line is `NN:  code` with a bare `^` pointer.
 */
export function parseCodeFrame(frame: string): Snippet | undefined {
  const all = frame.split('\n')
  const lines: string[] = []
  let start: number | undefined
  for (const raw of all) {
    const match = FRAME_LINE_RE.exec(raw)
    if (match) {
      start ??= Number(match[2])
      lines.push(match[3] ?? '')
    }
  }
  if (start !== undefined) {
    return { start, lines }
  }
  const from = colonFrameStart(all)
  if (from === undefined) {
    return
  }
  for (const raw of all.slice(from)) {
    const match = COLON_LINE_RE.exec(raw)
    if (!match) {
      continue
    }
    const line = Number(match[2])
    if (start !== undefined && line !== start + lines.length) {
      break
    }
    start ??= line
    lines.push(match[3] ?? '')
  }
  return start === undefined ? undefined : { start, lines }
}

/** Recover the error location from a code frame, for compile errors that ship a frame but no `loc`. */
export function locFromCodeFrame(frame: string): { line: number, column: number } | undefined {
  const all = frame.split('\n')
  let line: number | undefined
  let prefix = 0
  for (const raw of all) {
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
  const from = colonFrameStart(all)
  if (from === undefined) {
    return
  }
  for (const raw of all.slice(from)) {
    const numbered = COLON_LINE_RE.exec(raw)
    if (numbered) {
      line = Number(numbered[2])
      prefix = numbered[1]!.length
      continue
    }
    const caret = BARE_CARET_RE.exec(raw)
    if (caret && line !== undefined) {
      return { line, column: Math.max(1, caret[1]!.length - prefix + 1) }
    }
  }
}

const LABELLED_FRAME_RE = /[\u2500\u252C\u256D\u250C\-]\[[^\S\n]*([^[\]\s]+):(\d+):(\d+)[^\S\n]*\]/

/** Position from an oxc / miette style frame header such as `╭─[ src/a.ts:2:24 ]`. */
export function locFromLabelledFrame(text: string): { file: string, line: number, column: number } | undefined {
  const match = LABELLED_FRAME_RE.exec(text)
  return match ? { file: match[1]!, line: Number(match[2]), column: Number(match[3]) } : undefined
}

/** Strip an embedded code frame (oxc / esbuild style) from a compiler message, keeping the prose. */
export function stripEmbeddedFrame(message: string): string {
  const lines = message.split('\n')
  const pipe = lines.findIndex(line => LABELLED_FRAME_RE.test(line) || /^\s*\d+\s*[│|]/.test(line))
  const colon = colonFrameStart(lines)
  const candidates = [pipe, colon ?? -1].filter(index => index > 0)
  const start = candidates.length ? Math.min(...candidates) : -1
  if (start <= 0) {
    return message
  }
  return lines.slice(0, start).join('\n').replace(/\s+$/, '')
}

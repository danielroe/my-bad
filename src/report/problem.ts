import type { ErrorReport, Frame, ReportOptions, Snippet } from '../types'
import { stripAnsi } from './ansi'
import { defaultCwd, lineLength, reportId, resolveFile, truncate } from './create'
import { langFromFile, normalizeSlashes } from './path'
import { cropSnippet, parseCodeFrame } from './snippet'
import { tokenizeSnippet } from './tokenize'

export interface ProblemInput {
  /** Heads the report, and prefixes its message in problem lists unless it repeats the set's `label` (or `source`). */
  name: string
  message: string
  code?: string
  docsUrl?: string
  /** Absolute, or relative to `cwd`. */
  file?: string
  line?: number
  column?: number
  /** Source around `line`: a `Snippet`, or a code frame of `3 | code` lines, which may mark a line with `>`. */
  snippet?: Snippet | string
  /** Default `error`. */
  kind?: 'error' | 'warning'
}

export type ProblemReportOptions = Pick<ReportOptions, 'cwd' | 'maxMessageLength' | 'maxSnippetLineLength' | 'tokenizer'>

/**
 * Build a report from a diagnostic another tool has already located, without
 * reading any file. Its `id` hashes the name, message and location as
 * `createReport` does, so the same problem gets the same id either way.
 */
export function createProblemReport(input: ProblemInput, options: ProblemReportOptions = {}): ErrorReport {
  const cwd = options.cwd ?? defaultCwd()
  const file = input.file
    ? resolveFile(normalizeSlashes(input.file), cwd)
    : undefined
  const snippet = toSnippet(input.snippet, file, input.column, options)
  const frame: Frame | undefined = file || snippet
    ? {
        ...(file && { file }),
        ...(input.line !== undefined && { line: input.line }),
        ...(input.column !== undefined && { column: input.column }),
        type: 'app',
        ...(snippet && { snippet }),
      }
    : undefined
  const report: ErrorReport = {
    id: '',
    kind: input.kind ?? 'error',
    name: input.name,
    message: truncate(stripAnsi(input.message), options.maxMessageLength ?? 10_000),
    ...(input.code && { code: input.code }),
    ...(input.code && input.code === input.name && { diagnostic: true as const }),
    ...(input.docsUrl && { docsUrl: input.docsUrl }),
    frames: frame
      ? [frame]
      : [],
    causes: [],
    sections: [],
    timestamp: Date.now(),
  }
  report.id = reportId(report)
  return report
}

const MARKER_RE = /^(\s*)>/gm

function toSnippet(input: Snippet | string | undefined, file: string | undefined, column: number | undefined, options: ProblemReportOptions): Snippet | undefined {
  const parsed = typeof input === 'string'
    ? parseCodeFrame(stripAnsi(input).replace(MARKER_RE, '$1 '))
    : input
  if (!parsed?.lines.length) {
    return
  }
  const lang = parsed.lang ?? (file && langFromFile(file))
  const snippet = cropSnippet({
    ...parsed,
    ...(lang && { lang }),
  }, column, lineLength(options.maxSnippetLineLength))
  return options.tokenizer
    ? {
        ...snippet,
        tokens: tokenizeSnippet(snippet, options.tokenizer),
      }
    : snippet
}

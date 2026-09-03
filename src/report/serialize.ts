import type { ErrorReport, Frame } from '../types'
import { relativeToCwd } from './path'

export interface SerializeOptions {
  cwd?: string
  /** Drop snippets to keep the payload small. Default `false`. */
  snippets?: boolean
}

/** Produce a copy of the report with paths relative to `cwd`, suitable for JSON responses. */
export function serializeReport(report: ErrorReport, options: SerializeOptions = {}): ErrorReport {
  const { cwd, snippets = true } = options
  const frame = (f: Frame): Frame => ({
    ...f,
    ...(cwd && f.file && { file: relativeToCwd(f.file, cwd) }),
    ...(cwd && f.compiled && { compiled: { ...f.compiled, file: relativeToCwd(f.compiled.file, cwd) } }),
    ...(!snippets && { snippet: undefined }),
  })
  return {
    ...report,
    frames: report.frames.map(frame),
    causes: report.causes.map(cause => serializeReport(cause, options)),
    ...(report.errors && { errors: report.errors.map(error => serializeReport(error, options)) }),
    ...(report.trace && cwd && { trace: report.trace.map(entry => entry.file ? { ...entry, file: relativeToCwd(entry.file, cwd) } : entry) }),
  }
}

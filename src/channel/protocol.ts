import type { ErrorReport, HistoryEntry } from '../types'

export type LogLevel = 'trace' | 'debug' | 'info' | 'log' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  level: LogLevel
  text: string
  timestamp: number
}

export interface BuildProgress {
  phase: string
  percent?: number
  message?: string
  /**
   * Identifies the publisher of this update. The channel keeps the most recent
   * update per source and broadcasts the least advanced of them, so several
   * publishers can report independently without the bar jumping backwards.
   */
  source?: string
}

/** The request a report came from, so a page can tell whether an error is about itself. */
export interface ReportRequest {
  requestId?: string
  /** `METHOD /path?query`. */
  request?: string
}

/** `checking` while a source is producing a new set, `idle` once it has published it, `failed` when it could not. */
export type ProblemStatus = 'checking' | 'idle' | 'failed'

export interface ProblemMeta {
  /** Name of the source as shown to the user, e.g. `TypeScript`. */
  label?: string
  /** Sources sharing a group are counted together in the badge under this name, e.g. `Nuxt`, as one entry. */
  group?: string
  /** No status means `idle`. */
  status?: ProblemStatus
  /** Why the source failed, with `status: 'failed'`. */
  error?: string
  /** URL of a page listing the problems in full, shown in a frame, so it must allow framing by the app. */
  url?: string
  /** Id of a Vite DevTools dock listing the problems in full, shown in place of `url` when the page runs DevTools. */
  devtoolsDock?: string
}

/** A problem set as pages receive it: its counts, without the reports. */
export interface ProblemSummary extends ProblemMeta {
  source: string
  errors: number
  warnings: number
}

export interface ProblemChanges {
  /** Reports new to the set, or whose kind changed, in full. */
  added: ErrorReport[]
  /** Ids of the reports no longer in the set. */
  removed: string[]
}

export interface ProblemSet extends ProblemMeta {
  source: string
  reports: ErrorReport[]
}

export type ChannelEvent
  = | { type: 'hello', payload: { version: string, actions: string[], current?: ErrorReport, history?: HistoryEntry[], problems?: ProblemSummary[] } }
    | { type: 'error:set', payload: { report: ErrorReport, history: HistoryEntry[] } & ReportRequest }
    | { type: 'history', payload: { history: HistoryEntry[] } }
    | { type: 'error:clear', payload: { id?: string } }
    | { type: 'warning', payload: { report: ErrorReport, history: HistoryEntry[] } }
    | { type: 'warning:clear', payload: { id?: string, history: HistoryEntry[] } }
    | { type: 'log', payload: LogEntry & ReportRequest }
    | { type: 'build', payload: BuildProgress }
    /** Sinks also get the reports that joined the set and the ids of those that left it. */
    | { type: 'problems', payload: ProblemSummary & Partial<ProblemChanges> }
    | { type: 'problems:clear', payload: { source?: string } }

export function toHistoryEntry(report: ErrorReport): HistoryEntry {
  return {
    id: report.id,
    kind: report.kind,
    name: report.name,
    message: report.message,
    timestamp: report.timestamp,
  }
}

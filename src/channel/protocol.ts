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

export type ChannelEvent
  = | { type: 'hello', payload: { version: string, actions: string[], current?: ErrorReport, history?: HistoryEntry[] } }
    | { type: 'error:set', payload: { report: ErrorReport, history: HistoryEntry[] } & ReportRequest }
    | { type: 'history', payload: { history: HistoryEntry[] } }
    | { type: 'error:clear', payload: { id?: string } }
    | { type: 'warning', payload: { report: ErrorReport, history: HistoryEntry[] } }
    | { type: 'log', payload: LogEntry & ReportRequest }
    | { type: 'build', payload: BuildProgress }

export function toHistoryEntry(report: ErrorReport): HistoryEntry {
  return { id: report.id, kind: report.kind, name: report.name, message: report.message, timestamp: report.timestamp }
}

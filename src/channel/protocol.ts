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
}

export type ChannelEvent
  = | { type: 'hello', payload: { version: string, actions: string[], current?: ErrorReport, history?: HistoryEntry[] } }
    | { type: 'error:set', payload: { report: ErrorReport, history: HistoryEntry[] } }
    | { type: 'error:clear', payload: { id?: string } }
    | { type: 'warning', payload: { report: ErrorReport, history: HistoryEntry[] } }
    | { type: 'log', payload: LogEntry }
    | { type: 'build', payload: BuildProgress }

export function toHistoryEntry(report: ErrorReport): HistoryEntry {
  return { id: report.id, kind: report.kind, name: report.name, message: report.message, timestamp: report.timestamp }
}

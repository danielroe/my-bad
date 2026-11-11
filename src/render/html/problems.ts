import type { ProblemSummary } from '../../channel/protocol'
import type { ErrorReport, HistoryEntry, ReportKind } from '../../types'
import type { IndexView, Level } from './state'
import { plainText } from '../../report/code'
import { displayPath } from '../../report/path'
import { reportLocation } from './summary'

/** An entry of the list: a report, or a warning known only from the history. */
export type Listed = ErrorReport | HistoryEntry

export const LEVELS: Level[] = ['error', 'warning', 'info']

export function levelOf(kind: ReportKind): Level {
  return kind === 'warning' || kind === 'info'
    ? kind
    : 'error'
}

/** Whether a view narrows the list down by text or level. */
export function filtering(view: IndexView): boolean {
  return !!(view.filter?.trim() || view.hiddenLevels?.length)
}

export function matches(entry: Listed, view: IndexView, cwd: string | undefined): boolean {
  if (view.hiddenLevels?.includes(levelOf(entry.kind))) {
    return false
  }
  const filter = view.filter?.trim().toLowerCase()
  if (!filter) {
    return true
  }
  const frame = 'frames' in entry
    ? reportLocation(entry)
    : undefined
  return [
    entry.name,
    plainText(entry.message, entry.codeSpans),
    'code' in entry && entry.code,
    frame?.file && displayPath(frame, cwd),
  ].some(text => text && text.toLowerCase().includes(filter))
}

export type SourceTone = 'busy' | 'error' | 'warning' | 'ok'

export function sourceTone(set: ProblemSummary): SourceTone {
  return set.status === 'failed'
    ? 'error'
    : set.status === 'checking'
      ? 'busy'
      : set.errors
        ? 'error'
        : set.warnings
          ? 'warning'
          : 'ok'
}

/** What a source is doing, for example `Checking` or `Checked 3s ago`. */
export function sourceStatus(set: ProblemSummary, now: number): string {
  if (set.status === 'failed') {
    return `Failed: ${set.error || 'unknown reason'}`
  }
  if (set.status === 'checking') {
    return set.lastRun?.finishedAt === undefined
      ? 'Starting'
      : 'Checking'
  }
  return set.lastRun?.finishedAt === undefined
    ? 'Idle'
    : `Checked ${ago(set.lastRun.finishedAt, now)}`
}

function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  return seconds < 5
    ? 'just now'
    : seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : `${Math.floor(seconds / 3600)}h ago`
}

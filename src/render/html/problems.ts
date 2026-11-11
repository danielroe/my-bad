import type { ProblemSummary } from '../../channel/protocol'

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

import type { ErrorReport, Frame, HistoryEntry } from '../../types'
import type { DockedIndex } from './state'
import { splitHeadline } from '../../report/message'

export function warningCount(history: HistoryEntry[] | undefined): number {
  return history?.filter(entry => entry.kind === 'warning').length ?? 0
}

/** Open errors and warnings. A failed problem set counts as one error. */
export function dockedCounts(index: DockedIndex): { errors: number, warnings: number } {
  const sets = index.problems
  return {
    errors: (index.current ? 1 : 0) + sets.reduce((total, set) => total + (set.status === 'failed'
      ? 1
      : set.errors), 0),
    warnings: warningCount(index.history) + sets.reduce((total, set) => total + (set.status === 'failed'
      ? 0
      : set.warnings), 0),
  }
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1
    ? ''
    : 's'}`
}

export function countsLabel(counts: { errors: number, warnings: number }): string {
  return [
    counts.errors && plural(counts.errors, 'error'),
    counts.warnings && plural(counts.warnings, 'warning'),
  ].filter(Boolean).join(' · ')
}

/** Where a report points: its first app frame with a file, or its first frame with one. */
export function reportLocation(report: ErrorReport): Frame | undefined {
  return report.frames.find(frame => frame.file && frame.type === 'app') ?? report.frames.find(frame => frame.file)
}

/** Whether a name only repeats the label of the problem set it is listed under, ignoring case. */
export function repeatsLabel(name: string, label: string | undefined): boolean {
  return label !== undefined && name.toLowerCase() === label.toLowerCase()
}

export function firstLine(text: string): string {
  return splitHeadline(text).headline
}

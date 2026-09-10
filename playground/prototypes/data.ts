import type { LogEntry } from '../../src/channel/protocol'
import type { ErrorReport } from '../../src/types'

export const cases = [
  { id: 'healthy', group: 'Employee directory', label: 'Working directory', description: 'Browse employees, search, filter, and save profile changes.' },
  { id: 'wrapped', group: 'Employee directory', label: 'Load employees · Missing name', description: 'An employee record has no name. Loading the directory fails with one validation cause.' },
  { id: 'client', group: 'Employee directory', label: 'Open profile · Missing data', description: 'Click View profile. The app tries to read a name from a missing profile.' },
  { id: 'async', group: 'Employee directory', label: 'Save changes · Missing department', description: 'Save the Design employee profile. Cost-center lookup reads a missing department, causing a TypeError wrapped by the save operation.' },
  { id: 'api', group: 'Employee directory', label: 'Refresh employees · Invalid JSON', description: 'Click Refresh employees. Parsing a truncated employee export throws a native SyntaxError in the server.' },
  { id: 'not-found', group: 'Employee directory', label: 'Employee not found', description: 'A link points to an employee who is no longer in the directory.' },
  { id: 'compile', group: 'Employee directory', label: 'Broken page template', description: 'The directory header has a missing closing tag. Vue cannot compile the page.' },
  { id: 'hydration', group: 'Edge cases', label: 'Last updated · Hydration mismatch', description: 'The server and browser display different update times, triggering a real Vue hydration warning.' },
  { id: 'warning', group: 'Edge cases', label: 'Employee count · Invalid prop', description: 'The employee count receives a negative value and Vue reports a prop validation warning.' },
  { id: 'aggregate', group: 'Edge cases', label: 'Import · Several invalid rows', description: 'Click Validate sample import. The CSV validator collects failures from three actual invalid rows into an AggregateError.' },
  { id: 'deep', group: 'Edge cases', label: 'Restore directory · Nested causes', description: 'A truncated export fails JSON parsing. The import reader and directory restore each preserve the cause while adding context.' },
  { id: 'no-stack', group: 'Edge cases', label: 'Directory error · No stack', description: 'A directory error has no stack or source location.' },
  { id: 'long', group: 'Edge cases', label: 'Import · Long validation message', description: 'Click Validate sample import. Eighteen invalid CSV rows produce a detailed validation summary.' },
  { id: 'escaped', group: 'Edge cases', label: 'Employee name · Special characters', description: 'Click Validate sample import. Name validation rejects a CSV value containing HTML and Unicode, which must render as text.' },
  { id: 'burst', group: 'Edge cases', label: 'Sync · Independent failures', description: 'Click Sync directory. JSON parsing, profile lookup, and date formatting fail independently; one job retries to test deduplication.' },
] as const
export type CaseId = typeof cases[number]['id']
export interface Scenario {
  label: string
  category: string
  environment: string
  route: string
  report: ErrorReport
  occurrences: number
}
export interface LabState {
  cwd: string
  versions: Record<string, string>
  scenario: CaseId
  run: number
  path: string
  ready: boolean
  busy: boolean
  fixed: boolean
  delay: number
  phase: string
  reports: Scenario[]
  archived: Scenario[]
  logs: LogEntry[]
}
export async function command(action: string, payload: Record<string, unknown> = {}): Promise<LabState | undefined> {
  const response = await fetch(`/__lab/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok)
    throw new Error(await response.text())
  return response.status === 204 ? undefined : response.json()
}

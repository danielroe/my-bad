import type { Employee } from './employees'
import { faultEnabled } from './faults'

// Faults change the data entering app operations, not the errors those operations produce.
export function directoryRecords(records: Employee[]) {
  return records.map((employee, index) => ({ ...employee, name: faultEnabled && index === 0 ? '' : employee.name }))
}

export function profileRecords(employee: Employee) {
  return faultEnabled ? [] : [employee]
}

export function directoryExport(records: Employee[]) {
  const contents = JSON.stringify({ employees: records })
  return faultEnabled ? contents.slice(0, -12) : contents
}

export function employeeImport(kind: 'aggregate' | 'long' | 'escaped') {
  const header = 'name,email,department'
  const valid = 'Alex Morgan,alex.morgan@example.com,Design'
  if (!faultEnabled)
    return `${header}\n${valid}`
  if (kind === 'long')
    return `${header}\n${Array.from({ length: 18 }, (_, index) => `Employee ${index + 1},missing-email,Engineering`).join('\n')}`
  if (kind === 'escaped')
    return `${header}\n<script>alert("xss")</script> & <img src=x onerror=alert(1)> — 日本語 / café / 🚀,alex@example.com,Design`
  return `${header}\n,alex@example.com,Design\n${valid}\nSam Rivera,invalid-email,Engineering\n${valid}\nJamie Chen,jamie@example.com,`
}

export function syncInputs(records: Employee[]) {
  return {
    employees: directoryExport(records),
    profiles: faultEnabled ? [] : records,
    updatedAt: faultEnabled ? 'yesterday afternoon' : '2026-09-09T10:00:00Z',
  }
}

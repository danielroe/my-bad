import type { Employee } from './employees'

export function validateEmployee(employee: Employee) {
  if (!employee.name.trim())
    throw new TypeError(`Employee ${employee.id} is missing a name`)
  return employee
}

export function loadEmployees(records: Employee[]) {
  try {
    return records.map(validateEmployee)
  }
  catch (cause) {
    throw new Error('Could not load employees', { cause })
  }
}

export function findEmployee(records: Employee[], id: number) {
  return records.find(employee => employee.id === id)
}

export function profileTitle(records: Employee[], id: number) {
  const employee = findEmployee(records, id)
  return employee!.name
}

export function parseDirectoryExport(contents: string): Employee[] {
  return JSON.parse(contents).employees
}

export function readDirectoryExport(contents: string) {
  try {
    return loadEmployees(parseDirectoryExport(contents))
  }
  catch (cause) {
    throw new Error('Could not read employees.json', { cause })
  }
}

export function restoreDirectory(contents: string) {
  try {
    return readDirectoryExport(contents)
  }
  catch (cause) {
    throw new Error('Could not restore the employee directory', { cause })
  }
}

export function formatSyncTime(value: string) {
  return new Date(value).toISOString()
}

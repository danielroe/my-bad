export interface ImportedEmployee {
  name: string
  email: string
  department: string
}

function validateImportRow(row: ImportedEmployee, line: number) {
  if (!row.name.trim())
    throw new TypeError(`Row ${line}: employee name is missing`)
  if (/[<>]/.test(row.name))
    throw new TypeError(`Row ${line}: employee name contains unsupported characters: ${row.name}`)
  if (!/^[^@\s]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(row.email))
    throw new TypeError(`Row ${line}: invalid email address "${row.email}"`)
  if (!row.department.trim())
    throw new TypeError(`Row ${line}: department is missing`)
  return row
}

export function importEmployees(csv: string, summarize = false) {
  const errors: Error[] = []
  const employees: ImportedEmployee[] = []
  for (const [index, line] of csv.trim().split('\n').slice(1).entries()) {
    const [name = '', email = '', department = ''] = line.split(',')
    try {
      employees.push(validateImportRow({ name, email, department }, index + 2))
    }
    catch (error) {
      errors.push(error as Error)
    }
  }
  if (errors.length) {
    if (summarize)
      throw new Error(`Could not import employees.csv. ${errors.length} rows need attention.\n\n${errors.map(error => error.message).join('\n')}`)
    throw new AggregateError(errors, `Could not import employees.csv: ${errors.length} invalid ${errors.length === 1 ? 'row' : 'rows'}`)
  }
  return employees
}

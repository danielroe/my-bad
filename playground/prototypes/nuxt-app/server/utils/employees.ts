import type { Employee } from '../../shared/employees'
import { employees } from '../../shared/employees'
import { departmentDirectory, resolveCostCenter } from './department-directory'

export async function readEmployees(): Promise<Employee[]> {
  return await useStorage('memory').getItem<Employee[]>('directory:employees') ?? employees.map(employee => ({ ...employee }))
}

async function persistEmployee(records: Employee[], employee: Employee, incompleteDepartments: boolean) {
  const costCenter = resolveCostCenter(employee.department, departmentDirectory(incompleteDepartments))
  await useStorage('memory').setItem('directory:employees', records)
  await useStorage('memory').setItem(`directory:cost-center:${employee.id}`, costCenter)
}

export async function saveEmployee(id: number, changes: Pick<Employee, 'name' | 'email' | 'department'>, incompleteDepartments = false) {
  const records = (await readEmployees()).map(employee => ({ ...employee }))
  const employee = records.find(employee => employee.id === id)
  if (!employee)
    throw createError({ statusCode: 404, message: 'Employee not found' })
  try {
    Object.assign(employee, changes)
    await persistEmployee(records, employee, incompleteDepartments)
    return employee
  }
  catch (cause) {
    throw new Error(`Could not save changes for ${employee.name}`, { cause })
  }
}

import { faultEnabled } from '../../shared/faults'

interface Department {
  name: string
  costCenter: string
}

export function departmentDirectory(incomplete: boolean): Department[] {
  const departments = [
    { name: 'Design', costCenter: 'DSN' },
    { name: 'Engineering', costCenter: 'ENG' },
    { name: 'People', costCenter: 'PPL' },
    { name: 'Product', costCenter: 'PRD' },
  ]
  return incomplete && faultEnabled ? departments.slice(1) : departments
}

export function resolveCostCenter(name: string, departments: Department[]) {
  const department = departments.find(department => department.name === name)
  return department!.costCenter.trim()
}

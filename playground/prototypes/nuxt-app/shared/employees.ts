export interface Employee {
  id: number
  name: string
  email: string
  role: string
  department: string
  location: string
}

export const employees: Employee[] = [
  { id: 1, name: 'Alex Morgan', email: 'alex.morgan@example.com', role: 'Product designer', department: 'Design', location: 'London' },
  { id: 2, name: 'Sam Rivera', email: 'sam.rivera@example.com', role: 'Frontend engineer', department: 'Engineering', location: 'Paris' },
  { id: 3, name: 'Jamie Chen', email: 'jamie.chen@example.com', role: 'Engineering manager', department: 'Engineering', location: 'London' },
  { id: 4, name: 'Robin Patel', email: 'robin.patel@example.com', role: 'People partner', department: 'People', location: 'Amsterdam' },
  { id: 5, name: 'Taylor Brooks', email: 'taylor.brooks@example.com', role: 'Product manager', department: 'Product', location: 'Berlin' },
  { id: 6, name: 'Jordan Lee', email: 'jordan.lee@example.com', role: 'Brand designer', department: 'Design', location: 'Paris' },
]

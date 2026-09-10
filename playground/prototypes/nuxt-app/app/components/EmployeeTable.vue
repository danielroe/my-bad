<script setup lang="ts">
import type { Employee } from '../../shared/employees'
import { loadEmployees, restoreDirectory } from '../../shared/directory'
import { faultEnabled } from '../../shared/faults'
import { directoryExport, directoryRecords } from '../../shared/scenario-inputs'

defineEmits<{ select: [employee: Employee] }>()
const props = defineProps<{ scenario: string, employees: Employee[] }>()

if (props.scenario === 'wrapped')
  loadEmployees(directoryRecords(props.employees))
if (props.scenario === 'deep')
  restoreDirectory(directoryExport(props.employees))
if (props.scenario === 'no-stack' && faultEnabled) {
  // A remote service serialized its error without a stack.
  const payload = JSON.parse('{"name":"DirectoryUnavailableError","message":"The employee directory is temporarily unavailable"}')
  const error = Object.assign(new Error(), payload)
  error.stack = undefined
  throw error
}
if (props.scenario === 'not-found' && faultEnabled)
  throw createError({ statusCode: 404, statusMessage: 'Employee not found', message: 'This employee is no longer in the directory' })
</script>

<template>
  <div class="table-container">
    <table>
      <thead><tr><th scope="col">Employee</th><th scope="col">Department</th><th scope="col">Location</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        <tr v-for="employee in employees" :key="employee.id">
          <td><div class="employee-name"><span class="avatar" aria-hidden="true">{{ employee.name.split(' ').map(part => part[0]).join('') }}</span><span><strong>{{ employee.name }}</strong><span class="employee-role">{{ employee.role }}</span></span></div></td>
          <td>{{ employee.department }}</td><td>{{ employee.location }}</td>
          <td><button class="profile-link" type="button" :aria-label="`View ${employee.name}'s profile`" @click="$emit('select', employee)">View profile</button></td>
        </tr>
        <tr v-if="!employees.length"><td colspan="4" class="empty-list">No employees match your search. Try another name or department.</td></tr>
      </tbody>
    </table>
  </div>
</template>

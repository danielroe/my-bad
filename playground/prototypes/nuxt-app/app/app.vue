<script setup lang="ts">
import type { Employee } from '../shared/employees'
import { formatSyncTime, parseDirectoryExport, profileTitle } from '../shared/directory'
import { importEmployees as validateEmployeeImport } from '../shared/employee-import'
import { faultEnabled } from '../shared/faults'
import { employeeImport, profileRecords, syncInputs } from '../shared/scenario-inputs'

const route = useRoute()
const kind = String(route.query.case || 'healthy')
const { data: employees, refresh } = await useFetch<Employee[]>('/app/api/employees', { default: () => [] })
const search = ref('')
const department = ref('All departments')
const profile = ref<Employee | null>(null)
const profileDialog = ref<HTMLDialogElement>()
const form = reactive({ name: '', email: '', department: '' })
const saving = ref(false)
const status = ref('')
const departments = ['Design', 'Engineering', 'People', 'Product']
const visibleEmployees = computed(() => employees.value.filter(employee =>
  (department.value === 'All departments' || employee.department === department.value)
  && `${employee.name} ${employee.email} ${employee.role}`.toLowerCase().includes(search.value.toLowerCase()),
))
const updatedAt = kind === 'hydration' && faultEnabled && import.meta.client ? '10:01' : '10:00'

function showProfile(employee: Employee) {
  if (kind === 'client')
    profileTitle(profileRecords(employee), employee.id)
  profile.value = employee
  Object.assign(form, { name: employee.name, email: employee.email, department: employee.department })
  status.value = ''
  profileDialog.value?.showModal()
}

async function saveProfile() {
  if (!profile.value)
    return
  saving.value = true
  try {
    const employee = await $fetch<Employee>(`/app/api/employees/${profile.value.id}`, {
      method: 'PATCH', query: { case: kind, run: route.query.run }, body: { ...form },
    })
    employees.value = employees.value.map(item => item.id === employee.id ? employee : item)
    profileDialog.value?.close()
    status.value = `Saved changes to ${employee.name}.`
  }
  catch {
    status.value = 'Changes could not be saved. Please try again.'
  }
  finally {
    saving.value = false
  }
}

async function refreshEmployees() {
  if (kind === 'api') {
    const response = await fetch(`/app/api/employees/export?run=${route.query.run}`)
    if (!response.ok) {
      status.value = 'The directory could not be refreshed.'
      return
    }
    employees.value = await response.json()
  }
  else {
    await refresh()
  }
  status.value = 'The employee directory is up to date.'
}

function syncDirectory() {
  status.value = 'Syncing the directory…'
  const input = syncInputs(employees.value)
  const tasks = [
    () => parseDirectoryExport(input.employees),
    () => profileTitle(input.profiles, employees.value[0]!.id),
    () => formatSyncTime(input.updatedAt),
  ]
  // Repeat the first failed job to exercise report deduplication.
  const jobs = faultEnabled ? [...tasks, tasks[0]!] : tasks
  let remaining = jobs.length
  let failed = false
  for (const [index, task] of jobs.entries()) {
    setTimeout(() => {
      try {
        task()
      }
      catch (error) {
        failed = true
        throw error
      }
      finally {
        if (--remaining === 0)
          status.value = failed ? 'Some directory updates failed. Please retry.' : 'Employee data, profiles, and update time are in sync.'
      }
    }, index * 180)
  }
}

function importEmployees() {
  const kindOfImport = kind === 'long' || kind === 'escaped' ? kind : 'aggregate'
  const records = validateEmployeeImport(employeeImport(kindOfImport), kindOfImport === 'long')
  status.value = `${records.length} employee records passed validation.`
}

onMounted(() => {
  window.parent.postMessage({ source: 'nuxt-lab-app', type: 'mounted', run: Number(route.query.run), fixed: !faultEnabled }, window.location.origin)
  if (kind === 'async' && employees.value[0])
    showProfile(employees.value[0])
})
</script>

<template>
  <div class="directory-app">
    <header class="app-header"><span class="app-name">People</span><span class="app-section">Employee directory</span></header>
    <main class="directory-main">
      <div class="directory-heading">
        <div><h1>Employees</h1><DirectoryHeader /></div>
        <button type="button" class="control" @click="refreshEmployees">Refresh employees</button>
      </div>
      <div class="directory-filters">
        <label class="search-field"><span class="sr-only">Search employees</span><input v-model="search" type="search" placeholder="Search by name, email, or role"></label>
        <label><span class="sr-only">Department</span><select v-model="department"><option>All departments</option><option v-for="item in departments" :key="item">{{ item }}</option></select></label>
        <EmployeeCount :count="kind === 'warning' && faultEnabled ? -1 : visibleEmployees.length" />
      </div>
      <EmployeeTable :employees="visibleEmployees" :scenario="kind" @select="showProfile" />
      <p v-if="kind === 'hydration'" class="updated-at">Last updated at {{ updatedAt }}</p>
      <div v-if="['aggregate', 'long', 'escaped', 'burst'].includes(kind)" class="extra-actions">
        <button v-if="kind !== 'burst'" class="control" @click="importEmployees">Validate sample import</button>
        <button v-if="kind === 'burst'" class="control" @click="syncDirectory">Sync directory</button>
      </div>
      <p class="save-status" role="status">{{ status }}</p>
    </main>
    <dialog ref="profileDialog" class="profile-dialog" aria-labelledby="profile-title">
      <form @submit.prevent="saveProfile">
        <div class="profile-heading"><h2 id="profile-title">Employee profile</h2><button class="control" type="button" @click="profileDialog?.close()">Close</button></div>
        <p class="profile-role">{{ profile?.role }} · {{ profile?.location }}</p>
        <label>Full name<input v-model="form.name" autocomplete="off" required></label>
        <label>Email address<input v-model="form.email" type="email" autocomplete="off" required></label>
        <label>Department<select v-model="form.department"><option v-for="item in departments" :key="item">{{ item }}</option></select></label>
        <p v-if="status" class="save-status" role="status">{{ status }}</p>
        <div class="profile-actions"><button class="control" type="button" @click="profileDialog?.close()">Cancel</button><button class="control primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save changes' }}</button></div>
      </form>
    </dialog>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: #24282f; background: #fff; }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: wait; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #24282f; outline-offset: 3px; }
.app-header { height: 64px; padding: 0 32px; display: flex; align-items: center; gap: 20px; border-bottom: 1px solid #e8e9eb; }
.app-name { font-size: 18px; font-weight: 650; }
.app-section { color: #737880; border-left: 1px solid #e0e2e5; padding-left: 20px; }
.directory-main { max-width: 1080px; margin: auto; padding: 48px 32px; }
.directory-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 32px; }
h1 { font-size: 28px; letter-spacing: -.6px; margin: 0; font-weight: 600; }
.directory-description { color: #737880; margin: 6px 0 0; }
.control, input, select { min-height: 36px; border: 1px solid #dce0e4; border-radius: 6px; padding: 7px 12px; background: #fff; color: inherit; }
.control:hover { background: #f5f6f7; }
.directory-filters { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.search-field { flex: 1; max-width: 360px; }
.search-field input { width: 100%; }
.employee-count { color: #737880; margin-left: auto; white-space: nowrap; }
.table-container { position: relative; overflow-x: auto; border: 1px solid #e0e3e6; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; }
th { text-align: left; font-size: 12px; font-weight: 500; color: #737880; background: #fafbfc; }
th, td { padding: 14px 18px; }
td { border-top: 1px solid #eceef0; }
.employee-name { display: flex; align-items: center; gap: 12px; }
.employee-name strong { font-weight: 500; }
.avatar { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: #f1f3f5; color: #69717a; font-size: 12px; }
.employee-role { display: block; color: #737880; font-size: 12px; margin-top: 2px; }
.profile-link { border: 0; background: transparent; text-decoration: underline; text-underline-offset: 3px; padding: 8px 0; color: #505862; }
.empty-list { white-space: normal; padding: 32px; text-align: center; color: #737880; }
.profile-dialog { color: inherit; width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 24px; border: 1px solid #dce0e4; border-radius: 10px; box-shadow: 0 16px 64px #0002; }
.profile-dialog::backdrop { background: #161c2755; }
.profile-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.profile-heading h2 { font-size: 19px; margin: 0; }
.profile-role { color: #737880; margin: 8px 0 24px; }
.profile-dialog label { display: grid; gap: 6px; margin-top: 16px; font-size: 13px; }
.profile-dialog input, .profile-dialog select { width: 100%; }
.profile-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
.primary { background: #24282f; border-color: #24282f; color: white; }
.primary:hover { background: #3b414a; }
.save-status, .updated-at { color: #737880; font-size: 13px; margin: 16px 0 0; }
.extra-actions { margin-top: 20px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@media (max-width: 640px) {
  .app-header { padding: 0 20px; }
  .directory-main { padding: 28px 20px; }
  .directory-heading, .directory-filters { flex-wrap: wrap; gap: 12px; }
  .search-field { flex-basis: 100%; max-width: none; }
  .directory-description { max-width: 32ch; }
  th, td { padding: 12px; }
  th:nth-child(2), th:nth-child(3), td:nth-child(2), td:nth-child(3) { display: none; }
  table { white-space: normal; }
  .profile-link { white-space: nowrap; }
  .avatar { display: none; }
}
</style>

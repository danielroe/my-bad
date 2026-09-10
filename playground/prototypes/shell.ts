import type { LabState } from './data'
import { escapeHtml as esc } from '../../src/render/html/escape'
import { cases, command } from './data'
import './style.css'
import './shell.css'

const params = new URLSearchParams(location.search)
let view = ['focus', 'workbench', 'trace', 'stack'].includes(params.get('view') ?? '') ? params.get('view')! : 'focus'
let theme = params.get('theme') === 'dark' ? 'dark' : 'light'
let state: LabState | undefined
let disconnected = false
let activeFile = ''
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `<header class="harness-header"><a class="lab-brand" href="/">my-bad</a><label>Prototype<select id="prototype">${['focus', 'workbench', 'trace', 'stack'].map(name => `<option value="${name}" ${view === name ? 'selected' : ''}>${name[0]!.toUpperCase() + name.slice(1)}</option>`).join('')}</select></label><label>Scenario<select id="scenario">${['Employee directory', 'Edge cases'].map(group => `<optgroup label="${group}">${cases.filter(item => item.group === group).map(item => `<option value="${item.id}" ${item.id === 'healthy' ? 'selected' : ''}>${item.label}</option>`).join('')}</optgroup>`).join('')}</select></label><button class="button" id="run" disabled>Run</button><button class="button" id="fix" disabled>Apply fix</button><button class="button" id="source">Source</button><button class="button" id="error-visibility" disabled>Hide error</button><details class="harness-options"><summary>Options</summary><div class="options-panel"><label>Viewport<select id="viewport"><option value="full">Responsive</option><option value="1440">Desktop · 1440</option><option value="768">Tablet · 768</option><option value="390">Phone · 390</option><option value="320">Narrow · 320</option></select></label><label>Presentation<select id="presentation"><option value="page">Full page</option><option value="overlay">Overlay</option></select></label><label>Latency<select id="delay"><option value="0">Normal</option><option value="800">800 ms</option><option value="2500">2.5 seconds</option></select></label><button class="button" id="connection">Disconnect stream</button><button class="button" id="theme">${theme === 'dark' ? 'Light theme' : 'Dark theme'}</button><button class="button" id="history">Previous errors</button><a class="button" href="/review/index.html" target="_blank" rel="noopener">Before / after review ↗</a><span id="server-status">Starting Nuxt…</span></div></details><span id="phase" role="status">Starting Nuxt</span></header><main class="harness-stage"><div id="preview-size"><iframe id="preview" title="Error screen prototype" src="/screen.html?view=${view}&theme=${theme}"></iframe></div></main><dialog id="source-dialog" aria-labelledby="source-title"><form method="dialog" class="dialog-heading"><h2 id="source-title">Edit playground source</h2><button class="button" aria-label="Close source editor">Close</button></form><label class="file-picker">File<select id="source-file"></select></label><p class="source-description">Saves the real file used by Nuxt. HMR rebuilds it; reload the app to retry SSR failures.</p><textarea id="source-code" spellcheck="false" aria-label="Source code"></textarea><div class="source-editor-actions"><span id="save-status" role="status"></span><button class="button" id="save-source">Save file</button><button class="button" id="reload">Reload app</button></div></dialog>`
const preview = document.querySelector<HTMLIFrameElement>('#preview')!
function send(type: string, data: Record<string, unknown> = {}) {
  preview.contentWindow?.postMessage({ source: 'nuxt-lab-shell', type, ...data }, location.origin)
}
function updateUrl() {
  history.replaceState(null, '', `?${new URLSearchParams({ view, theme })}`)
}
async function refresh() {
  try {
    const response = await fetch('/__lab/state')
    if (!response.ok)
      throw new Error('Playground server unavailable')
    state = await response.json()
    send('app', { path: state!.path, ready: state!.ready })
    const ready = state!.ready && !state!.busy
    document.querySelector<HTMLButtonElement>('#run')!.disabled = !ready
    document.querySelector<HTMLButtonElement>('#fix')!.disabled = !ready || state!.fixed || state!.scenario === 'healthy'
    document.querySelector<HTMLSelectElement>('#scenario')!.disabled = !ready
    document.querySelector('#server-status')!.textContent = state!.ready ? `Nuxt ${state!.versions.Nuxt}` : 'Starting Nuxt…'
    document.querySelector('#phase')!.textContent = state!.phase
    if (ready)
      document.querySelector<HTMLSelectElement>('#scenario')!.value = state!.scenario
    document.querySelector('#scenario')!.setAttribute('title', cases.find(item => item.id === state!.scenario)!.description)
  }
  catch (error) {
    document.querySelector('#phase')!.textContent = String(error)
  }
}
async function perform(action: string, body: Record<string, unknown> = {}) {
  document.querySelector<HTMLButtonElement>('#run')!.disabled = true
  document.querySelector<HTMLButtonElement>('#fix')!.disabled = true
  try {
    await command(action, body)
  }
  catch (error) {
    document.querySelector('#phase')!.textContent = String(error)
  }
  await refresh()
  send('refresh')
}
document.querySelector('#prototype')!.addEventListener('change', () => {
  view = document.querySelector<HTMLSelectElement>('#prototype')!.value
  send('design', { view, theme })
  updateUrl()
})
document.querySelector('#error-visibility')!.addEventListener('click', () => send('toggle-error'))
document.querySelector('#history')!.addEventListener('click', () => send('history'))
document.querySelector('#theme')!.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  send('design', { view, theme })
  document.querySelector('#theme')!.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'
  updateUrl()
})
document.querySelector('#run')!.addEventListener('click', () => perform('run', { scenario: document.querySelector<HTMLSelectElement>('#scenario')!.value }))
document.querySelector('#scenario')!.addEventListener('change', () => perform('run', { scenario: document.querySelector<HTMLSelectElement>('#scenario')!.value }))
document.querySelector('#fix')!.addEventListener('click', () => perform('fix'))
document.querySelector('#delay')!.addEventListener('change', () => perform('settings', { delay: Number(document.querySelector<HTMLSelectElement>('#delay')!.value) }))
document.querySelector('#presentation')!.addEventListener('change', () => send('presentation', { value: document.querySelector<HTMLSelectElement>('#presentation')!.value }))
document.querySelector('#viewport')!.addEventListener('change', () => {
  const width = document.querySelector<HTMLSelectElement>('#viewport')!.value
  document.querySelector<HTMLElement>('#preview-size')!.style.width = width === 'full' ? '100%' : `${width}px`
})
document.querySelector('#connection')!.addEventListener('click', () => {
  disconnected = !disconnected
  send('connection', { connected: !disconnected })
  document.querySelector('#connection')!.textContent = disconnected ? 'Reconnect stream' : 'Disconnect stream'
})
const sourceDialog = document.querySelector<HTMLDialogElement>('#source-dialog')!
async function loadSource(file: string) {
  const response = await fetch('/__lab/source', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) })
  if (!response.ok)
    throw new Error(await response.text())
  const data = await response.json()
  activeFile = data.file
  document.querySelector<HTMLTextAreaElement>('#source-code')!.value = data.content
  document.querySelector('#save-status')!.textContent = ''
}
async function showSource(file?: string) {
  if (!state)
    return
  const files = ['shared/faults.ts', 'app/app.vue', 'app/components/DirectoryHeader.vue', 'app/components/EmployeeCount.vue', 'app/components/EmployeeTable.vue', 'server/api/employees/export.get.ts', 'shared/employees.ts', 'server/api/employees/[id].patch.ts', 'server/utils/employees.ts', 'shared/directory.ts', 'shared/employee-import.ts', 'shared/scenario-inputs.ts', 'server/utils/department-directory.ts']
  const chosen = file && file.startsWith(state.cwd) && !file.includes('/.nuxt/') && !file.includes('/node_modules/') ? file.slice(state.cwd.length + 1) : state.scenario === 'compile' ? files[2]! : files[0]!
  if (!files.includes(chosen))
    files.push(chosen)
  document.querySelector('#source-file')!.innerHTML = files.map(item => `<option value="${esc(`${state!.cwd}/${item}`)}" ${item === chosen ? 'selected' : ''}>${esc(item)}</option>`).join('')
  await loadSource(`${state.cwd}/${chosen}`)
  sourceDialog.showModal()
}
document.querySelector('#source')!.addEventListener('click', () => showSource().catch((error) => {
  document.querySelector('#phase')!.textContent = String(error)
}))
document.querySelector('#source-file')!.addEventListener('change', () => loadSource(document.querySelector<HTMLSelectElement>('#source-file')!.value).catch((error) => {
  document.querySelector('#save-status')!.textContent = String(error)
}))
document.querySelector('#save-source')!.addEventListener('click', async () => {
  try {
    await command('save', { file: activeFile, content: document.querySelector<HTMLTextAreaElement>('#source-code')!.value })
    document.querySelector('#save-status')!.textContent = 'Saved to disk. Nuxt is rebuilding.'
  }
  catch (error) {
    document.querySelector('#save-status')!.textContent = String(error)
  }
})
document.querySelector('#reload')!.addEventListener('click', () => {
  sourceDialog.close()
  send('reload')
})
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== preview.contentWindow || event.data?.source !== 'nuxt-lab-screen')
    return
  if (event.data.type === 'visibility') {
    const button = document.querySelector<HTMLButtonElement>('#error-visibility')!
    button.disabled = !event.data.hasIssues
    button.textContent = event.data.visible ? 'Hide error' : 'Show error'
  }
  if (event.data.type === 'theme') {
    theme = event.data.theme === 'dark' ? 'dark' : 'light'
    document.querySelector('#theme')!.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'
    updateUrl()
  }
  if (event.data.type === 'edit')
    void showSource(event.data.file)
  if (event.data.type === 'ready')
    send('design', { view, theme })
})
const events = new EventSource('/__lab/events')
for (const event of ['hello', 'build', 'error:set', 'error:clear', 'warning']) events.addEventListener(event, () => void refresh())
events.onerror = () => {
  document.querySelector('#server-status')!.textContent = 'Playground disconnected'
}
void refresh()

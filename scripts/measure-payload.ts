/** Prints the byte cost of a representative Nuxt-shaped report. Run `pnpm build` first. */
import { createReport, renderOverlay, renderPage } from '../dist/index.mjs'

const files: Record<string, string> = {
  '/proj/app/pages/index.vue': `<script setup lang="ts">
const { data } = await useFetch('/api/widgets')
const total = computed(() => data.value.items.reduce((sum, item) => sum + item.price, 0))
</script>

<template>
  <div class="page">
    <WidgetList :items="data.items" :total="total" />
  </div>
</template>
`,
  '/proj/app/composables/useWidgets.ts': `import type { Widget } from '~/types'

export function useWidgets(): Ref<Widget[]> {
  const state = useState<Widget[]>('widgets', () => [])
  if (!state.value.length) {
    throw new Error('widgets have not been fetched yet')
  }
  return state
}
`,
  '/proj/server/api/widgets.get.ts': `import { widgets } from '../utils/store'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const items = await widgets.list({ limit: Number(query.limit ?? 20) })
  return { items }
})
`,
  '/proj/server/utils/store.ts': `import { createStorage } from 'unstorage'

export const widgets = {
  async list(options: { limit: number }) {
    const raw = await createStorage().getItem('widgets')
    return JSON.parse(raw).slice(0, options.limit)
  },
}
`,
}

function stack(frames: string[]): string {
  return frames.map(frame => `    at ${frame}`).join('\n')
}

const inner = new Error('Unexpected token < in JSON at position 0')
inner.stack = `SyntaxError: Unexpected token < in JSON at position 0\n${stack([
  'JSON.parse (<anonymous>)',
  'Object.list (/proj/server/utils/store.ts:6:17)',
  'async /proj/server/api/widgets.get.ts:5:19',
  'async Object.handler (/proj/node_modules/h3/dist/index.mjs:1902:19)',
  'async toNodeHandle (/proj/node_modules/h3/dist/index.mjs:2296:7)',
  'async node:internal/process/task_queues:95:5',
])}`

const error = Object.assign(new Error('[GET /api/widgets] Internal Server Error'), {
  code: 'ERR_INTERNAL',
  statusCode: 500,
  cause: inner,
  data: {
    url: '/api/widgets?limit=20',
    method: 'GET',
    headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    query: { limit: '20' },
  },
})
error.stack = `Error: [GET /api/widgets] Internal Server Error\n${stack([
  'useWidgets (/proj/app/composables/useWidgets.ts:6:11)',
  'setup (/proj/app/pages/index.vue:2:23)',
  'callWithErrorHandling (/proj/node_modules/@vue/runtime-core/dist/runtime-core.cjs.js:199:19)',
  'renderComponentVNode (/proj/node_modules/@vue/server-renderer/dist/server-renderer.cjs.js:453:16)',
  'async Object.handler (/proj/node_modules/h3/dist/index.mjs:1902:19)',
  'async node:internal/process/task_queues:95:5',
])}`

const report = await createReport(error, {
  cwd: '/proj',
  loaders: [{ name: 'memory', read: file => files[file] }],
})

const assets = { script: '/__my-bad/client.js', styles: '/__my-bad/client.css' }
const options = { cwd: '/proj', channel: '/__my-bad', assets }
const page = renderPage(report, options)
const overlay = renderOverlay(report, options)
const state = page.slice(page.indexOf('<script type="application/json">'), page.indexOf('</script>', page.indexOf('<script type="application/json">')))

const rows = {
  'JSON.stringify(report)': JSON.stringify(report).length,
  'inline page state': state.length,
  'renderPage (assets set)': page.length,
  'renderOverlay (assets set)': overlay.length,
}
for (const [label, size] of Object.entries(rows)) {
  console.log(`${label.padEnd(28)} ${String(size).padStart(7)} bytes`)
}

import { resolve } from 'node:path'

const root = process.cwd()
const dist = process.env.MY_BAD_DIST!
const hub = process.env.MY_BAD_HUB!
const token = process.env.MY_BAD_TOKEN!

export default defineNuxtConfig({
  telemetry: false,
  devtools: { enabled: true },
  app: { baseURL: '/app/' },
  sourcemap: { server: true, client: true },
  experimental: { appManifest: false },
  nitro: {
    errorHandler: resolve(root, 'error-handler.ts'),
    alias: { 'my-bad': `${dist}/index.mjs`, 'my-bad/presets': `${dist}/presets/index.mjs`, '#fixture/runtime': resolve(root, 'runtime/nuxt-v4.ts') },
  },
  vite: { server: { hmr: { overlay: false } } },
  hooks: {
    'vite:serverCreated': function (server) {
      const send = server.ws.send.bind(server.ws)
      server.ws.send = ((...args: any[]) => {
        const payload = args[0]
        if (payload && typeof payload === 'object' && payload.type === 'error') {
          void fetch(`${hub}/__lab/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lab-token': token }, body: JSON.stringify({ input: payload.err, kind: 'compile', environment: 'Vite' }) }).catch(() => {})
        }
        return send(...args as Parameters<typeof send>)
      }) as typeof server.ws.send
    },
  },
})

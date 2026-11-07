import type { Plugin, PluginOption } from 'vite'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { myBad, useMyBad } from '../../dist/vite/index.mjs'

/** A server route that throws, registered before Vite's HTML fallback. */
const ssrRoute: Plugin = {
  name: 'playground-ssr-route',
  configureServer(server) {
    server.middlewares.use('/ssr-error', async (_req, res) => {
      const ctx = useMyBad(server)!
      try {
        const mod = await server.ssrLoadModule('/src/server-route.ts')
        res.end(JSON.stringify(mod.loadUser('42')))
      }
      catch (error) {
        const report = await ctx.emit(error)
        res.statusCode = 500
        res.setHeader('content-type', 'text/html')
        res.end(ctx.page(report))
      }
    })
  },
}

/** Publishes a problem set, as a type checker would, at `/set-problems?count=n`, with `&checking` while it runs. */
const problems: Plugin = {
  name: 'playground-problems',
  configureServer(server) {
    server.middlewares.use('/set-problems', async (req, res) => {
      const ctx = useMyBad(server)!
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      const count = Number(query.get('count') ?? 2)
      const file = fileURLToPath(new URL('./src/broken.ts', import.meta.url))
      const reports = await Promise.all(Array.from({ length: count }, (_, index) => ctx.report({
        name: `TS${2322 + index}`,
        message: index % 2
          ? `Property 'nme' does not exist on type 'User'. Did you mean 'name'?`
          : `Type 'number' is not assignable to type 'string'.`,
        loc: { file, line: 1 + (index % 3), column: 10 + index },
      }, {
        kind: index === 2
          ? 'warning'
          : 'error',
      })))
      ctx.channel.setProblems('typescript', reports, {
        label: 'TypeScript',
        url: 'https://www.typescriptlang.org/',
        status: query.has('checking')
          ? 'checking'
          : 'idle',
      })
      res.end(`published ${count}`)
    })
  },
}

const devtools = process.argv.includes('--devtools')
  ? (await import('@vitejs/devtools')).DevTools({ clientAuth: false })
  : undefined

const server = await createServer({
  root: import.meta.dirname,
  configFile: false,
  plugins: [
    devtools as PluginOption,
    myBad(),
    ssrRoute,
    problems,
  ],
  server: {
    port: 4322,
    host: process.argv.includes('--host'),
  },
})

await server.listen()
server.printUrls()
console.log('\n  open the URL above, then break src/broken.ts; visit /ssr-error for a server error page\n  visit /set-problems?count=3 to publish a problem set\n  pass --host to listen on all interfaces, --devtools to add Vite DevTools\n')

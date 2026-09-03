import type { Plugin } from 'vite'
import process from 'node:process'
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

const server = await createServer({
  root: import.meta.dirname,
  configFile: false,
  plugins: [myBad(), ssrRoute],
  server: { port: 4322, host: process.argv.includes('--host') },
})

await server.listen()
server.printUrls()
console.log('\n  open the URL above, then break src/broken.ts; visit /ssr-error for a server error page\n  pass --host to listen on all interfaces\n')

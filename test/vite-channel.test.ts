import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'
import { myBad } from '../src/vite'

const root = fileURLToPath(new URL('./fixtures/vite-ssr/', import.meta.url)).replace(/\/$/, '')

describe('vite channel', () => {
  it('refuses to open files for a peer on the network', async () => {
    const opened: unknown[] = []
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      plugins: [
        myBad({
          channel: {
            open: request => void opened.push(request),
          },
        }),
      ],
    })
    let peer = '192.168.1.20'
    const http = createHttpServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
      server.middlewares(req, res)
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as { port: number }
    const open = () => fetch(`http://127.0.0.1:${port}/__my-bad/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: `${root}/src/lib.ts` }),
    }).then(res => res.status)
    try {
      expect(await open()).toBe(403)
      expect(opened).toEqual([])
      peer = '127.0.0.1'
      expect(await open()).toBe(204)
      expect(opened).toHaveLength(1)
    }
    finally {
      http.close()
      await server.close()
    }
  })
})

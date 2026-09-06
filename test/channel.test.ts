import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReport } from '../src'
import { createChannel } from '../src/channel'

const servers: Array<() => void> = []
afterEach(() => {
  for (const close of servers.splice(0)) {
    close()
  }
})

async function listen(channel: ReturnType<typeof createChannel>): Promise<string> {
  const server = createServer(async (req, res) => {
    if (!(await channel.handler(req, res))) {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => {
    channel.close()
    server.close()
  })
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/__my-bad`
}

async function readEvents(url: string, count: number, signal: AbortSignal): Promise<Array<{ event: string, data: any }>> {
  const res = await fetch(`${url}/events`, { signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{ event: string, data: any }> = []
  while (events.length < count) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let index: number
    // eslint-disable-next-line no-cond-assign
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (event && data) {
        events.push({ event, data: JSON.parse(data) })
      }
    }
  }
  reader.cancel().catch(() => {})
  return events
}

describe('createChannel', () => {
  it('sends hello, error:set and error:clear over SSE', async () => {
    const opened: unknown[] = []
    const events: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request), sink: event => void events.push(event.type) })
    const url = await listen(channel)
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })

    const controller = new AbortController()
    const received = readEvents(url, 3, controller.signal)
    while (channel.clients === 0) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    channel.setError(report)
    channel.clearError()
    const [hello, set, clear] = await received
    controller.abort()

    expect(hello).toMatchObject({ event: 'hello', data: { actions: ['open'], history: [] } })
    expect(set).toMatchObject({ event: 'error:set', data: { report: { id: report.id }, history: [{ id: report.id }] } })
    expect(clear).toMatchObject({ event: 'error:clear' })
    expect(events).toEqual(['error:set', 'error:clear'])

    const file = resolve('a.ts')
    const res = await fetch(`${url}/open`, { method: 'POST', body: JSON.stringify({ file, line: 3 }) })
    expect(res.status).toBe(204)
    expect(opened).toEqual([{ file, line: 3, column: undefined }])
    expect((await fetch(`${url}/open`, { method: 'POST', body: '{}' })).status).toBe(400)
  })

  it('keeps bounded history and serves reports by id', async () => {
    const channel = createChannel({ history: 2 })
    const url = await listen(channel)
    const reports = await Promise.all(['a', 'b', 'c'].map(msg => createReport(new Error(msg), { loaders: [], snippets: false })))
    for (const report of reports) {
      channel.setError(report)
    }
    expect(channel.history.map(entry => entry.message)).toEqual(['b', 'c'])
    expect(channel.current?.message).toBe('c')
    expect((await fetch(`${url}/history/${reports[2]!.id}`)).status).toBe(200)
    expect((await fetch(`${url}/history/${reports[0]!.id}`)).status).toBe(404)
    expect((await fetch(`${url}/nothing`)).status).toBe(404)
  })

  it('works through the fetch handler', async () => {
    const channel = createChannel()
    const report = await createReport(new Error('x'), { loaders: [], snippets: false })
    channel.setError(report)
    const res = await channel.fetchHandler(new Request('http://localhost/__my-bad/events'))
    expect(res?.headers.get('content-type')).toBe('text/event-stream')
    const reader = res!.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: hello')
    expect(text).toContain(report.id)
    await reader.cancel()
    expect(await channel.fetchHandler(new Request('http://localhost/other'))).toBeUndefined()
    const missing = await channel.fetchHandler(new Request(`http://localhost/__my-bad/history/nope`))
    expect(missing?.status).toBe(404)
    channel.close()
  })
})

describe('cross-origin requests', () => {
  const file = resolve('a.ts')

  async function post(url: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${url}/open`, { method: 'POST', headers, body: JSON.stringify({ file }) })
    return res.status
  }

  it('refuses requests made by a page on another site', async () => {
    const opened: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request) })
    const url = await listen(channel)

    expect(await post(url, { 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.example' })).toBe(403)
    expect(await post(url, { 'sec-fetch-site': 'same-site' })).toBe(403)
    expect(await post(url, { origin: 'https://evil.example' })).toBe(403)
    expect(await post(url, { origin: 'null' })).toBe(403)
    expect(opened).toEqual([])

    expect((await fetch(`${url}/events`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${url}/history/nope`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('allows same-origin and non-browser requests', async () => {
    const opened: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request) })
    const url = await listen(channel)
    const origin = new URL(url).origin

    expect(await post(url, { 'sec-fetch-site': 'same-origin', 'origin': origin })).toBe(204)
    expect(await post(url, { 'sec-fetch-site': 'none' })).toBe(204)
    expect(await post(url, { origin })).toBe(204)
    expect(await post(url, {})).toBe(204)
    expect(opened).toHaveLength(4)
  })

  it('gates the fetch handler too', async () => {
    const channel = createChannel({ open: () => {} })
    const evil = new Request('http://localhost:3000/__my-bad/open', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ file }),
    })
    expect((await channel.fetchHandler(evil))?.status).toBe(403)
    const same = new Request('http://localhost:3000/__my-bad/open', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
      body: JSON.stringify({ file }),
    })
    expect((await channel.fetchHandler(same))?.status).toBe(204)
    channel.close()
  })
})

describe('open containment', () => {
  it('rejects files outside the root and accepts files within it', async () => {
    const opened: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request) })
    const url = await listen(channel)

    const post = (file: string) => fetch(`${url}/open`, { method: 'POST', body: JSON.stringify({ file }) }).then(res => res.status)
    expect(await post('/etc/passwd')).toBe(400)
    expect(await post(`${resolve('src')}/../../outside.ts`)).toBe(400)
    expect(await post(resolve('src/index.ts'))).toBe(204)
    expect(opened).toEqual([{ file: resolve('src/index.ts'), line: undefined, column: undefined }])
  })

  it('honours an explicit root and opting out', async () => {
    const opened: unknown[] = []
    const confined = createChannel({ open: request => void opened.push(request), root: resolve('src') })
    const confinedUrl = await listen(confined)
    const post = (url: string, file: string) => fetch(`${url}/open`, { method: 'POST', body: JSON.stringify({ file }) }).then(res => res.status)
    expect(await post(confinedUrl, resolve('test/channel.test.ts'))).toBe(400)
    expect(await post(confinedUrl, resolve('src/index.ts'))).toBe(204)

    const anywhere = createChannel({ open: request => void opened.push(request), root: false })
    const anywhereUrl = await listen(anywhere)
    expect(await post(anywhereUrl, '/etc/passwd')).toBe(204)
  })
})

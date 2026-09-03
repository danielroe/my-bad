import { createServer } from 'node:http'
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

    const res = await fetch(`${url}/open`, { method: 'POST', body: JSON.stringify({ file: '/a.ts', line: 3 }) })
    expect(res.status).toBe(204)
    expect(opened).toEqual([{ file: '/a.ts', line: 3, column: undefined }])
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

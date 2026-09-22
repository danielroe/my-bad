import type { BuildProgress, OpenRequest } from '../src/channel'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReport } from '../src'
import { createChannel } from '../src/channel'
import { escapeCmdArg } from '../src/channel/open'

const JSON_HEADERS = { 'content-type': 'application/json' }

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

async function readEvents(url: string, count: number, signal: AbortSignal, query = ''): Promise<Array<{ event: string, data: any }>> {
  const res = await fetch(`${url}/events${query}`, { signal })
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

    const file = resolve('package.json')
    const res = await fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file, line: 3 }) })
    expect(res.status).toBe(204)
    expect(opened).toEqual([{ file, line: 3, column: undefined }])
    expect((await fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(400)
    expect((await fetch(`${url}/open`, { method: 'POST', body: JSON.stringify({ file }) })).status).toBe(415)
    expect(opened).toHaveLength(1)
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

  it('sends an error only to the pages its request concerns', async () => {
    const channel = createChannel()
    const url = await listen(channel)
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })

    const controller = new AbortController()
    const mine = readEvents(url, 2, controller.signal, '?requestId=a&path=/about')
    const theirs = readEvents(url, 2, controller.signal, '?requestId=b&path=/contact')
    while (channel.clients < 2) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    channel.setError(report, 'a', 'GET /about')
    const [[, set], [, other]] = await Promise.all([mine, theirs])
    controller.abort()

    expect(set).toMatchObject({ event: 'error:set', data: { report: { id: report.id }, requestId: 'a', request: 'GET /about' } })
    expect(other).toMatchObject({ event: 'history', data: { history: [{ id: report.id }] } })
  })

  it('ignores a clear naming a report that is no longer current', async () => {
    const events: string[] = []
    const channel = createChannel({ sink: event => void events.push(event.type) })
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })

    channel.setError(report, 'a', 'GET /about')
    channel.clearError(report.id)
    channel.clearError(report.id)
    expect(events).toEqual(['error:set', 'error:clear'])
    channel.close()
  })

  it('announces the current error in hello only to the pages it concerns', async () => {
    const channel = createChannel()
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })
    const hello = async (query: string): Promise<any> => {
      const res = await channel.fetchHandler(new Request(`http://localhost/__my-bad/events${query}`))
      const reader = res!.body!.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      return JSON.parse(/^data: (.+)$/m.exec(new TextDecoder().decode(value))![1]!)
    }

    channel.setError(report, 'a', 'GET /about')
    expect(await hello('?requestId=a')).toMatchObject({ current: { id: report.id } })
    expect(await hello('?path=/about')).toMatchObject({ current: { id: report.id } })
    expect((await hello('?requestId=b&path=/contact')).current).toBeUndefined()
    expect((await hello('?requestId=b&path=/contact')).history).toMatchObject([{ id: report.id }])
    channel.setError(report)
    expect(await hello('?requestId=b')).toMatchObject({ current: { id: report.id } })
    channel.close()
  })

  it('works through the fetch handler', async () => {
    const channel = createChannel()
    const report = await createReport(new Error('x'), { loaders: [], snippets: false })
    const hello = async (): Promise<string> => {
      const res = await channel.fetchHandler(new Request('http://localhost/__my-bad/events'))
      expect(res?.headers.get('content-type')).toBe('text/event-stream')
      const reader = res!.body!.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      return new TextDecoder().decode(value)
    }
    const payload = async (): Promise<any> => JSON.parse(/^data: (.+)$/m.exec(await hello())![1]!)
    expect(await hello()).toContain('event: hello')
    expect(await payload()).toMatchObject({ history: [] })
    expect((await payload()).current).toBeUndefined()
    channel.setError(report)
    expect(await payload()).toMatchObject({ current: { id: report.id }, history: [{ id: report.id }] })
    channel.clearError()
    expect((await payload()).current).toBeUndefined()
    expect(await channel.fetchHandler(new Request('http://localhost/other'))).toBeUndefined()
    const missing = await channel.fetchHandler(new Request(`http://localhost/__my-bad/history/nope`))
    expect(missing?.status).toBe(404)
    channel.close()
  })
})

describe('cross-origin requests', () => {
  const file = resolve('package.json')

  async function post(url: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${url}/open`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify({ file }) })
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
      headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ file }),
    })
    expect((await channel.fetchHandler(evil))?.status).toBe(403)
    const same = new Request('http://localhost:3000/__my-bad/open', {
      method: 'POST',
      headers: { ...JSON_HEADERS, origin: 'http://localhost:3000', host: 'localhost:3000' },
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

    const post = (file: string) => fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file }) }).then(res => res.status)
    expect(await post('/etc/passwd')).toBe(403)
    expect(await post(resolve('/outside.ts'))).toBe(400)
    expect(await post(resolve('src/index.ts'))).toBe(204)
    expect(await post('src/../src/index.ts')).toBe(204)
    expect(opened).toEqual([
      { file: resolve('src/index.ts'), line: undefined, column: undefined },
      { file: resolve('src/index.ts'), line: undefined, column: undefined },
    ])
  })

  it('honours an explicit root and opting out', async () => {
    const opened: unknown[] = []
    const confined = createChannel({ open: request => void opened.push(request), root: resolve('src') })
    const confinedUrl = await listen(confined)
    const post = (url: string, file: string) => fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file }) }).then(res => res.status)
    expect(await post(confinedUrl, resolve('test/channel.test.ts'))).toBe(403)
    expect(await post(confinedUrl, resolve('src/index.ts'))).toBe(204)

    const anywhere = createChannel({ open: request => void opened.push(request), root: false })
    const anywhereUrl = await listen(anywhere)
    expect(await post(anywhereUrl, '/etc/passwd')).toBe(204)
  })

  it('refuses a path that names no file', async () => {
    const opened: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request) })
    const url = await listen(channel)
    const post = (file: string) => fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file }) }).then(res => res.status)

    expect(await post(resolve('src/nope.ts'))).toBe(400)
    expect(await post(`${resolve('src/index.ts')}&calc.exe`)).toBe(400)
    expect(await post(resolve('src'))).toBe(400)
    expect(opened).toEqual([])
  })

  it('refuses a symlink pointing outside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-bad-root-'))
    const outside = join(await mkdtemp(join(tmpdir(), 'my-bad-out-')), 'secret.txt')
    await writeFile(outside, 'secret')
    await writeFile(join(dir, 'inside.txt'), 'fine')
    await symlink(outside, join(dir, 'link.txt'))

    const opened: OpenRequest[] = []
    const channel = createChannel({ open: request => void opened.push(request), root: dir })
    const url = await listen(channel)
    const post = (file: string) => fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file }) }).then(res => res.status)

    expect(await post(join(dir, 'link.txt'))).toBe(403)
    expect(await post(join(dir, 'inside.txt'))).toBe(204)
    expect(opened.map(request => request.file)).toEqual([await realpath(join(dir, 'inside.txt'))])
  })

  it('opens files in a root that is itself a symlink', async () => {
    const base = await mkdtemp(join(tmpdir(), 'my-bad-link-'))
    const real = join(base, 'project')
    await mkdir(real)
    await writeFile(join(real, 'app.ts'), 'export {}')
    const link = join(base, 'linked')
    await symlink(real, link)

    const opened: OpenRequest[] = []
    const channel = createChannel({ open: request => void opened.push(request), root: link })
    const url = await listen(channel)
    const res = await fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file: join(link, 'app.ts') }) })

    expect(res.status).toBe(204)
    expect(opened.map(request => request.file)).toEqual([await realpath(join(real, 'app.ts'))])
  })

  it('lets a function refuse a request', async () => {
    const channel = createChannel({ open: request => !request.file.endsWith('index.ts') })
    const url = await listen(channel)
    const post = (file: string) => fetch(`${url}/open`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ file }) }).then(res => res.status)

    expect(await post(resolve('src/index.ts'))).toBe(400)
    expect(await post(resolve('src/types.ts'))).toBe(204)
  })
})

describe('host validation', () => {
  const file = resolve('package.json')
  const body = JSON.stringify({ file })

  it('refuses browser requests addressed to a non-loopback host', async () => {
    const channel = createChannel({ open: () => {} })
    const post = (headers: Record<string, string>) => channel.fetchHandler(new Request('http://localhost:3000/__my-bad/open', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body })).then(res => res?.status)

    expect(await post({ 'sec-fetch-site': 'same-origin', 'host': 'rebound.example:3000' })).toBe(403)
    expect(await post({ origin: 'http://rebound.example:3000', host: 'rebound.example:3000' })).toBe(403)
    expect(await post({ host: 'rebound.example:3000' })).toBe(204)
    expect(await post({ 'sec-fetch-site': 'same-origin', 'host': 'app.localhost:3000' })).toBe(204)
    expect(await post({ 'sec-fetch-site': 'same-origin', 'host': '[::1]:3000' })).toBe(204)
    channel.close()
  })

  it('accepts IP-literal hosts', async () => {
    const channel = createChannel({ open: () => {} })
    const post = (host: string) => channel.fetchHandler(new Request('http://localhost:3000/__my-bad/open', { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin', host }, body })).then(res => res?.status)

    expect(await post('192.168.1.20:3000')).toBe(204)
    expect(await post('[fe80::1]:3000')).toBe(204)
    expect(await post('1.2.3.4.evil.example:3000')).toBe(403)
    channel.close()
  })

  it('honours allowedHosts', async () => {
    const channel = createChannel({ open: () => {}, allowedHosts: ['.example.dev', 'devbox'] })
    const post = (host: string) => channel.fetchHandler(new Request('http://localhost:3000/__my-bad/open', { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin', host }, body })).then(res => res?.status)

    expect(await post('app.example.dev:3000')).toBe(204)
    expect(await post('example.dev')).toBe(204)
    expect(await post('DevBox:3000')).toBe(204)
    expect(await post('devbox.evil.example')).toBe(403)
    channel.close()

    const any = createChannel({ open: () => {}, allowedHosts: true })
    expect((await any.fetchHandler(new Request('http://localhost:3000/__my-bad/open', { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin', 'host': 'anything.example' }, body })))?.status).toBe(204)
    any.close()
  })
})

describe('escapeCmdArg', () => {
  it('quotes and escapes cmd.exe metacharacters', () => {
    expect(escapeCmdArg('C:\\proj\\a.ts:3')).toBe('^^^"C:\\proj\\a.ts:3^^^"')
    expect(escapeCmdArg('a & calc')).toBe('^^^"a^^^ ^^^&^^^ calc^^^"')
    expect(escapeCmdArg('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"')
    expect(escapeCmdArg('dir\\')).toBe('^^^"dir\\\\^^^"')
  })
})

describe('build progress', () => {
  function collect() {
    const events: BuildProgress[] = []
    const channel = createChannel({ sink: event => void (event.type === 'build' && events.push(event.payload)) })
    return { channel, events }
  }

  it('reports the least advanced source when publishers interleave', () => {
    const { channel, events } = collect()
    channel.progress({ phase: 'startup', percent: 20, source: 'cli' })
    channel.progress({ phase: 'modules', percent: 80, source: 'app' })
    channel.progress({ phase: 'startup', percent: 60, source: 'cli' })
    channel.progress({ phase: 'restart', percent: 10 })
    channel.close()

    expect(events.map(event => event.percent)).toEqual([20, 20, 60, 10])
    expect(events[1]!.phase).toBe('startup')
  })

  it('stops counting a source that has finished', () => {
    const { channel, events } = collect()
    channel.progress({ phase: 'startup', percent: 30, source: 'cli' })
    channel.progress({ phase: 'modules', percent: 90, source: 'app' })
    channel.progress({ phase: 'startup', percent: 100, source: 'cli' })
    channel.progress({ phase: 'modules', percent: 100, source: 'app' })
    channel.close()

    expect(events.map(event => [event.source, event.percent])).toEqual([['cli', 30], ['cli', 30], ['app', 90], ['app', 100]])
  })
})

describe('untrusted callers', () => {
  async function hello(channel: ReturnType<typeof createChannel>, query: string, trusted?: boolean): Promise<any> {
    const res = await channel.fetchHandler(new Request(`http://localhost/__my-bad/events${query}`), { trusted })
    const reader = res!.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    return JSON.parse(/^data: (.+)$/m.exec(new TextDecoder().decode(value))![1]!)
  }

  it('scopes hello history to the caller', async () => {
    const channel = createChannel()
    const mine = await createReport(new Error('mine'), { loaders: [], snippets: false })
    const theirs = await createReport(new Error('theirs'), { loaders: [], snippets: false })
    channel.setError(mine, 'a', 'GET /about')
    channel.setError(theirs, 'b', 'GET /contact')

    expect((await hello(channel, '?requestId=a&path=/about', false)).history).toMatchObject([{ id: mine.id }])
    expect((await hello(channel, '?requestId=c&path=/other', false)).history).toEqual([])
    expect((await hello(channel, '?requestId=a&path=/about')).history).toMatchObject([{ id: mine.id }, { id: theirs.id }])
    expect((await hello(channel, '?requestId=a&path=/about', true)).history).toMatchObject([{ id: mine.id }, { id: theirs.id }])
    channel.close()
  })

  it('withholds the open action and refuses the endpoint', async () => {
    const opened: unknown[] = []
    const channel = createChannel({ open: request => void opened.push(request) })
    expect((await hello(channel, '?path=/about')).actions).toEqual(['open'])
    expect((await hello(channel, '?path=/about', false)).actions).toEqual([])

    const post = async (trusted?: boolean): Promise<number> => (await channel.fetchHandler(
      new Request('http://localhost/__my-bad/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: resolve('package.json') }) }),
      { trusted },
    ))!.status
    expect(await post(false)).toBe(403)
    expect(opened).toEqual([])
    expect(await post()).toBe(204)
    expect(opened).toHaveLength(1)
    channel.close()
  })

  it('shows a report published with no request to everyone', async () => {
    const channel = createChannel()
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })
    channel.setError(report)
    const warning = await createReport(new Error('warn'), { loaders: [], snippets: false })
    channel.warn(warning)
    const scoped = await createReport(new Error('scoped'), { loaders: [], snippets: false })
    channel.setError(scoped, 'a', 'GET /about')

    expect((await hello(channel, '?requestId=z&path=/nowhere', false)).history).toMatchObject([{ id: report.id }, { id: warning.id }])
    channel.close()
  })

  it('requires the request id of a report that names one', async () => {
    const channel = createChannel()
    const report = await createReport(new Error('boom'), { loaders: [], snippets: false })
    channel.setError(report, 'a', 'GET /admin')
    const status = async (query: string, trusted?: boolean): Promise<number> =>
      (await channel.fetchHandler(new Request(`http://localhost/__my-bad/history/${report.id}${query}`), { trusted }))!.status

    const guessed = await hello(channel, '?path=/admin', false)
    expect(guessed.current).toBeUndefined()
    expect(guessed.history).toEqual([])
    expect(await status('?path=/admin', false)).toBe(404)

    const owner = await hello(channel, '?requestId=a&path=/admin', false)
    expect(owner).toMatchObject({ current: { id: report.id }, history: [{ id: report.id }] })
    expect(await status('?requestId=a&path=/admin', false)).toBe(200)

    const loopback = await hello(channel, '?path=/admin')
    expect(loopback).toMatchObject({ current: { id: report.id }, history: [{ id: report.id }] })
    channel.close()
  })

  it('answers 404 for a report that does not concern the caller', async () => {
    const channel = createChannel()
    const mine = await createReport(new Error('mine'), { loaders: [], snippets: false })
    const theirs = await createReport(new Error('theirs'), { loaders: [], snippets: false })
    channel.setError(mine, 'a', 'GET /about')
    channel.setError(theirs, 'b', 'GET /contact')
    const get = async (id: string, query: string, trusted?: boolean): Promise<number> =>
      (await channel.fetchHandler(new Request(`http://localhost/__my-bad/history/${id}${query}`), { trusted }))!.status

    expect(await get(mine.id, '?requestId=a&path=/about', false)).toBe(200)
    expect(await get(theirs.id, '?requestId=a&path=/about', false)).toBe(404)
    expect(await get(theirs.id, '?requestId=a&path=/about')).toBe(200)
    expect(await get('nope', '?requestId=a&path=/about', false)).toBe(404)
    channel.close()
  })

  it('scopes the history streamed to untrusted subscribers', async () => {
    const channel = createChannel()
    const url = await listen(channel)
    const first = await createReport(new Error('first'), { loaders: [], snippets: false })
    const second = await createReport(new Error('second'), { loaders: [], snippets: false })

    const server = createServer(async (req, res) => {
      if (!(await channel.handler(req, res, { trusted: false }))) {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const untrustedUrl = `http://127.0.0.1:${address.port}/__my-bad`

    const controller = new AbortController()
    const trusted = readEvents(url, 3, controller.signal, '?requestId=x&path=/x')
    const untrusted = readEvents(untrustedUrl, 3, controller.signal, '?requestId=a&path=/about')
    while (channel.clients < 2) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    channel.setError(first, 'a', 'GET /about')
    channel.setError(second, 'b', 'GET /contact')
    const [[, , theirHistory], [, , myScoped]] = await Promise.all([trusted, untrusted])
    controller.abort()
    server.close()

    expect(theirHistory).toMatchObject({ event: 'history', data: { history: [{ id: first.id }, { id: second.id }] } })
    expect(myScoped!.data.history).toMatchObject([{ id: first.id }])
  })
})

describe('scoped logs', () => {
  function subscribe(channel: ReturnType<typeof createChannel>, query: string, trusted?: boolean) {
    const received: Array<{ event: string, data: any }> = []
    const ready = channel.fetchHandler(new Request(`http://localhost/__my-bad/events${query}`), { trusted }).then((res) => {
      const reader = res!.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const pump = async (): Promise<void> => {
        const { value, done } = await reader.read()
        if (done) {
          return
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
            received.push({ event, data: JSON.parse(data) })
          }
        }
        return pump()
      }
      pump().catch(() => {})
      return () => reader.cancel().catch(() => {})
    })
    return { received, ready }
  }

  async function logs(channel: ReturnType<typeof createChannel>, query: string, trusted?: boolean): Promise<string[]> {
    const { received, ready } = subscribe(channel, query, trusted)
    await ready
    channel.log({ level: 'info', text: 'unattributed' })
    channel.log({ level: 'info', text: 'theirs' }, 'b', 'GET /contact')
    channel.log({ level: 'info', text: 'mine' }, 'a', 'GET /about')
    await new Promise(resolve => setTimeout(resolve, 10))
    void (await ready)()
    return received.filter(event => event.event === 'log').map(event => event.data.text)
  }

  it('withholds unattributed and foreign logs from an untrusted subscriber', async () => {
    const channel = createChannel()
    expect(await logs(channel, '?requestId=a&path=/about', false)).toEqual(['mine'])
    channel.close()
  })

  it('sends every log to a trusted subscriber', async () => {
    const channel = createChannel()
    expect(await logs(channel, '?requestId=a&path=/about')).toEqual(['unattributed', 'theirs', 'mine'])
    channel.close()
  })

  it('will not match an attributed log by guessed path alone', async () => {
    const channel = createChannel()
    expect(await logs(channel, '?path=/about', false)).toEqual([])
    channel.close()
  })

  it('passes every log to the sink exactly once, with its attribution', async () => {
    const events: any[] = []
    const channel = createChannel({ sink: event => void (event.type === 'log' && events.push(event.payload)) })
    const { ready } = subscribe(channel, '?requestId=a&path=/about', false)
    await ready
    channel.log({ level: 'info', text: 'unattributed' })
    channel.log({ level: 'info', text: 'mine' }, 'a', 'GET /about')
    await new Promise(resolve => setTimeout(resolve, 10))
    void (await ready)()
    channel.close()

    expect(events).toMatchObject([
      { text: 'unattributed' },
      { text: 'mine', requestId: 'a', request: 'GET /about' },
    ])
    expect(events[0]).not.toHaveProperty('requestId')
    expect(events).toHaveLength(2)
  })

  it('leaves the frame a trusted subscriber receives unchanged for an unattributed log', async () => {
    const channel = createChannel()
    const { received, ready } = subscribe(channel, '?requestId=a&path=/about')
    await ready
    channel.log({ level: 'warn', text: 'careful', timestamp: 5 })
    await new Promise(resolve => setTimeout(resolve, 10))
    void (await ready)()
    channel.close()

    expect(received.filter(event => event.event === 'log').map(event => event.data)).toEqual([{ level: 'warn', text: 'careful', timestamp: 5 }])
  })
})

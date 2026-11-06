import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReport } from '../src'
import { createChannel } from '../src/channel'
import { combineSinks, fileSink } from '../src/sinks'

describe('sinks', () => {
  it('writes events as JSON lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-bad-'))
    const file = join(dir, 'nested', 'events.jsonl')
    const seen: string[] = []
    const channel = createChannel({
      sink: combineSinks(fileSink(file), event => void seen.push(event.type)),
    })
    const report = await createReport(new Error('x'), { loaders: [], snippets: false })
    channel.setError(report)
    channel.log({ level: 'warn', text: 'careful' })
    channel.progress({ phase: 'build' })
    let lines: any[] = []
    for (let attempt = 0; attempt < 100 && lines.length < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      lines = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    }
    expect(lines.map(line => line.type)).toEqual(['error:set', 'log'])
    expect(lines[0].payload.report.id).toBe(report.id)
    expect(seen).toEqual(['error:set', 'log', 'build'])
    channel.close()
  })

  it('records the reports that join and leave a problem set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-bad-'))
    const file = join(dir, 'events.jsonl')
    const channel = createChannel({
      sink: fileSink(file),
    })
    const report = await createReport(new Error('Type \'number\' is not assignable to type \'string\''), { loaders: [], snippets: false })
    channel.setProblems('typecheck', [report], { label: 'TypeScript', status: 'idle' })
    channel.setProblems('typecheck', [], { label: 'TypeScript', status: 'idle' })
    channel.clearProblems()
    let lines: any[] = []
    for (let attempt = 0; attempt < 100 && lines.length < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      lines = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    }
    expect(lines).toMatchObject([
      {
        type: 'problems',
        payload: {
          source: 'typecheck',
          label: 'TypeScript',
          errors: 1,
          added: [
            { id: report.id, message: report.message },
          ],
          removed: [],
        },
      },
      {
        type: 'problems',
        payload: {
          errors: 0,
          added: [],
          removed: [report.id],
        },
      },
      { type: 'problems:clear', payload: {} },
    ])
    channel.close()
  })
})

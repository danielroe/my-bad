import type { SourceLoader } from '../src/types'
import { describe, expect, it } from 'vitest'
import { createReport } from '../src'

const options = { loaders: [], snippets: false, cwd: '/proj' }

function stack(frames: number): string {
  return ['Error: boom', ...Array.from({ length: frames }, (_, index) => `    at fn${index} (/proj/src/file${index}.ts:${index + 1}:1)`)].join('\n')
}

describe('report bounds', () => {
  it('caps the number of related errors per level', async () => {
    const error = new AggregateError(Array.from({ length: 50 }, (_, index) => new Error(`nested ${index}`)), 'many')
    const report = await createReport(error, options)
    expect(report.errors).toHaveLength(20)
    expect(report.omittedErrors).toBe(30)
  })

  it('honours maxErrors and leaves omittedErrors unset below it', async () => {
    const error = new AggregateError([new Error('a'), new Error('b'), new Error('c')], 'many')
    expect(await createReport(error, { ...options, maxErrors: 2 })).toMatchObject({ omittedErrors: 1 })
    expect((await createReport(error, { ...options, maxErrors: 3 })).omittedErrors).toBeUndefined()
  })

  it('keeps frames past the mapping budget unmapped', async () => {
    const mapped: string[] = []
    const loader: SourceLoader = {
      name: 'test',
      map: (frame) => {
        mapped.push(frame.file!)
        return { ...frame, file: `${frame.file}.mapped` }
      },
    }
    const error = new Error('boom')
    error.stack = stack(10)
    const report = await createReport(error, { ...options, loaders: [loader], maxMappedFrames: 3 })
    expect(report.frames).toHaveLength(10)
    expect(mapped).toHaveLength(3)
    expect(report.frames[2]!.file).toBe('/proj/src/file2.ts.mapped')
    expect(report.frames[3]!.file).toBe('/proj/src/file3.ts')
    expect(report.frames[3]!.type).toBe('app')
  })

  it('shares the frame budget across causes', async () => {
    const mapped: string[] = []
    const loader: SourceLoader = {
      name: 'test',
      map: (frame) => {
        mapped.push(frame.file!)
        return undefined
      },
    }
    const cause = new Error('cause')
    cause.stack = stack(5)
    const error = new Error('boom', { cause })
    error.stack = stack(5)
    await createReport(error, { ...options, loaders: [loader], maxMappedFrames: 6 })
    expect(mapped).toHaveLength(6)
  })

  it('truncates oversized data sections and leaves small ones structured', async () => {
    const big = Object.assign(new Error('boom'), { data: { body: 'x'.repeat(5000) } })
    const content = (await createReport(big, { ...options, maxSectionLength: 100 })).sections[0]!.content
    expect(typeof content).toBe('string')
    expect(content).toContain('truncated')
    expect((content as string).length).toBeLessThan(200)

    const small = Object.assign(new Error('boom'), { data: { body: 'small' } })
    expect((await createReport(small, { ...options, maxSectionLength: 100 })).sections[0]!.content).toEqual({ body: 'small' })
  })

  it('truncates long messages', async () => {
    const report = await createReport(new Error('x'.repeat(500)), { ...options, maxMessageLength: 100 })
    expect(report.message.startsWith('x'.repeat(100))).toBe(true)
    expect(report.message).toContain('400 more characters')
  })

  it('truncates long raw stacks', async () => {
    const error = new Error('boom')
    error.stack = stack(400)
    const report = await createReport(error, { ...options, maxRawStackLength: 500 })
    expect(report.rawStack!.length).toBeLessThan(600)
    expect(report.rawStack).toContain('truncated')
  })
})

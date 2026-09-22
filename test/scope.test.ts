import { describe, expect, it } from 'vitest'
import { concernsClient, scopeFromQuery } from '../src/channel/scope'

describe('concernsClient', () => {
  it('sends a report with no request to every page', () => {
    expect(concernsClient({ requestId: 'a', path: '/a' }, {})).toBe(true)
  })

  it('matches request ids when both sides have one', () => {
    const scope = { requestId: 'a', path: '/a' }
    expect(concernsClient(scope, { requestId: 'a', request: 'GET /b' })).toBe(true)
    expect(concernsClient(scope, { requestId: 'b', request: 'GET /a' })).toBe(false)
  })

  it('falls back to the request path when either side has no id', () => {
    expect(concernsClient({ path: '/a?x=1' }, { requestId: 'b', request: 'GET /a?x=1' })).toBe(true)
    expect(concernsClient({ path: '/a' }, { request: 'POST /b' })).toBe(false)
    expect(concernsClient({ requestId: 'a' }, { requestId: 'b' })).toBe(false)
  })

  it('ignores the path fallback for an identified report when strict', () => {
    expect(concernsClient({ path: '/a' }, { requestId: 'b', request: 'GET /a' }, true)).toBe(false)
    expect(concernsClient({ requestId: 'b', path: '/a' }, { requestId: 'b', request: 'GET /a' }, true)).toBe(true)
    expect(concernsClient({ path: '/a' }, { request: 'GET /a' }, true)).toBe(true)
    expect(concernsClient({ path: '/a' }, {}, true)).toBe(true)
  })

  it('reads the scope a page connects with', () => {
    expect(scopeFromQuery(new URLSearchParams('requestId=a&path=/x%3Fy%3D1'))).toEqual({ requestId: 'a', path: '/x?y=1' })
    expect(scopeFromQuery(new URLSearchParams())).toEqual({ requestId: undefined, path: undefined })
  })
})

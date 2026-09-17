import type { ReportRequest } from './protocol'

/** The request a connected page was rendered for, taken from its `/events` query. */
export interface ClientScope {
  requestId?: string
  /** `pathname + search` of the page. */
  path?: string
}

export function scopeFromQuery(params: URLSearchParams): ClientScope {
  return {
    requestId: params.get('requestId') ?? undefined,
    path: params.get('path') ?? undefined,
  }
}

/** Whether a report from `request` concerns a page. A report with no request (compile error, client error) concerns every page. */
export function concernsClient(scope: ClientScope, request: ReportRequest): boolean {
  if (!request.requestId && !request.request) {
    return true
  }
  if (request.requestId && scope.requestId) {
    return request.requestId === scope.requestId
  }
  return request.request !== undefined && scope.path !== undefined && requestPath(request.request) === scope.path
}

/** `GET /a?b=1` names the path `/a?b=1`. */
function requestPath(request: string): string {
  return request.replace(/^\S+\s+/, '')
}

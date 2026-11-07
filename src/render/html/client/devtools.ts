import type { DevToolsMessageEntryInput, DevToolsMessageFilePosition } from '@vitejs/devtools-kit'
import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'
import type { ProblemSet } from '../../../channel/protocol'
import type { ErrorReport } from '../../../types'
import type { BadgeFocus, BadgeSnapshot, BadgeState } from '../state'
import { displayPath } from '../../../report/path'
import { countsLabel, dockedCounts, firstLine, plural, reportLocation } from '../summary'

type Activation = BadgeFocus & { open?: string }
type MessageAction = NonNullable<DevToolsMessageEntryInput['actions']>[number]

const PREFIX = 'my-bad:'
const ERRORS_KEY = 'my-bad:devtools:errors'
const PROBLEMS_KEY = 'my-bad:devtools:problems'
const DESCRIBED = 3

export interface DevToolsSetupOptions {
  /** The badge to mount when the page has none of its own. */
  badge?: { state: BadgeState, src: string }
}

export default async function setup(ctx: DockClientScriptContext, options: DevToolsSetupOptions = {}): Promise<void> {
  const entry = ctx.current.entryMeta
  const dockId = entry.id
  if (options.badge) {
    mountBadge(options.badge)
  }
  const source = await badgeSource()

  let pending: BadgeFocus | undefined
  const deliver = () => {
    const frame = ctx.current.domElements.iframe?.contentWindow
    if (pending && frame) {
      frame.postMessage({ type: 'my-bad:select', ...pending }, location.origin)
    }
  }
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== ctx.current.domElements.iframe?.contentWindow) {
      return
    }
    const type = (event.data as { type?: string } | undefined)?.type
    if (type === 'my-bad:ready') {
      deliver()
    }
    else if (type === 'my-bad:selected') {
      pending = undefined
    }
  })
  const show = async (focus: BadgeFocus) => {
    pending = focus
    if (!await ctx.docks.switchEntry(dockId)) {
      ctx.panel.session.open = true
    }
    deliver()
  }
  source.host = {
    open: focus => void show(focus),
  }
  dispatchEvent(new Event('my-bad:host'))

  const active = await ctx.rpc.sharedState.get('devframe:docks:active' as never, {
    initialValue: { activation: null },
  } as never) as unknown as {
    on: (event: 'updated', listener: (state: { activation?: { dockId: string, params?: Record<string, unknown> } | null }) => void) => void
  }
  active.on('updated', (state) => {
    const activation = state?.activation
    if (activation?.dockId !== dockId) {
      return
    }
    const params = (activation.params ?? {}) as Activation
    const url = safeUrl(params.open)
    if (url) {
      open(url, '_blank', 'noopener')
    }
    pending = { id: params.id, source: params.source }
    deliver()
  })

  const registration = ctx.docks.register({ ...entry }, true)
  let badge: string | undefined
  let problems = new Map<string, ProblemSet>()
  const errors = new Set(read<string[]>('sessionStorage', ERRORS_KEY) ?? [])
  const seen = new Map(Object.entries(read<Record<string, string[]>>('localStorage', PROBLEMS_KEY) ?? {}))
  const added = new Map<string, string>()

  const sync = () => {
    const snapshot = source.snapshot!()
    if (!snapshot.ready) {
      return
    }
    const counts = dockedCounts(snapshot)
    const total = counts.errors + counts.warnings
    const next = total
      ? `${counts.errors}:${counts.warnings}`
      : undefined
    if (next !== badge) {
      badge = next
      registration.update({
        badge: total
          ? String(total)
          : undefined,
        badgeVariant: counts.errors ? 'danger' : 'warning',
        title: total
          ? `${entry.title} (${countsLabel(counts)})`
          : entry.title,
      })
    }

    const messages = new Map<string, DevToolsMessageEntryInput>()
    const current = snapshot.current
    if (current) {
      messages.set(`${PREFIX}error:${current.id}`, {
        ...describe(current, snapshot),
        level: 'error',
        notify: !errors.has(current.id),
        actions: actions(dockId, { id: current.id }, current.docsUrl, 'Docs'),
      })
      errors.add(current.id)
    }
    for (const id of errors) {
      if (id !== current?.id) {
        errors.delete(id)
      }
    }
    write('sessionStorage', ERRORS_KEY, [...errors])

    for (const summary of snapshot.problems) {
      const set = problems.get(summary.source)
      const failed = summary.status === 'failed'
      if (!summary.errors && !summary.warnings && !failed) {
        seen.delete(summary.source)
        continue
      }
      const reports = set?.reports ?? []
      const known = new Set(seen.get(summary.source))
      const fresh = reports.some(report => !known.has(report.id))
      if (set) {
        seen.set(summary.source, reports.map(report => report.id))
      }
      const label = summary.group
        ? `${summary.group} · ${summary.label ?? summary.source}`
        : summary.label ?? summary.source
      const first = reports.find(report => report.kind === 'error') ?? reports[0]
      messages.set(`${PREFIX}problems:${summary.source}`, {
        message: failed
          ? `${label} failed${summary.error
            ? `: ${summary.error}`
            : ''}`
          : `${label}: ${countsLabel({ errors: summary.errors, warnings: summary.warnings })}`,
        description: reports.length
          ? [
              ...reports.slice(0, DESCRIBED).map(report => `${where(report, snapshot) ?? ''}  ${firstLine(report.message)}`.trim()),
              ...reports.length > DESCRIBED
                ? [`and ${plural(reports.length - DESCRIBED, 'more')}`]
                : [],
            ].join('\n')
          : undefined,
        level: failed || summary.errors
          ? 'error'
          : 'warn',
        filePosition: first && position(first),
        status: summary.status === 'checking'
          ? 'loading'
          : 'idle',
        notify: fresh,
        actions: actions(dockId, { source: summary.source }, summary.url, 'Full list'),
      })
    }
    for (const key of seen.keys()) {
      if (!snapshot.problems.some(summary => summary.source === key)) {
        seen.delete(key)
      }
    }
    write('localStorage', PROBLEMS_KEY, Object.fromEntries(seen))

    for (const id of added.keys()) {
      if (!messages.has(id)) {
        added.delete(id)
        void ctx.messages.remove(id)
      }
    }
    for (const [id, input] of messages) {
      const { notify, ...rest } = input
      const key = JSON.stringify(rest)
      if (added.get(id) !== key || notify) {
        added.set(id, key)
        void ctx.messages.add({ id, ...input })
      }
    }
  }

  let fetching: Promise<void> | undefined
  let stale = false
  const refetch = (): Promise<void> => {
    if (fetching) {
      stale = true
      return fetching
    }
    const channel = source.snapshot!().overlay.channel
    fetching = fetch(`${channel}/problems`)
      .then(res => res.ok
        ? res.json() as Promise<ProblemSet[]>
        : [])
      .catch(() => [] as ProblemSet[])
      .then((sets) => {
        problems = new Map(sets.map(set => [set.source, set]))
        fetching = undefined
        if (stale) {
          stale = false
          return refetch()
        }
      })
    return fetching
  }

  let queued = false
  const schedule = () => {
    if (!queued) {
      queued = true
      queueMicrotask(() => {
        queued = false
        sync()
      })
    }
  }
  for (const type of [
    'error:set',
    'error:clear',
    'history',
    'warning',
    'warning:clear',
    'problems:clear',
  ]) {
    source.addEventListener(type, schedule)
  }
  for (const type of ['hello', 'problems']) {
    source.addEventListener(type, () => void refetch().then(schedule))
  }
  await refetch()
  sync()
}

function mountBadge(badge: { state: BadgeState, src: string }): void {
  const mount = () => {
    if (window.__MY_BAD_SOURCE__) {
      return
    }
    const state = document.createElement('script')
    state.type = 'application/json'
    state.textContent = JSON.stringify({ ...badge.state, hosted: true })
    const script = document.createElement('script')
    script.src = badge.src
    document.body.append(state, script)
  }
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', mount, { once: true })
  }
  else {
    mount()
  }
}

function badgeSource(): Promise<MyBadSharedSource> {
  return new Promise((resolve) => {
    const found = () => {
      const source = window.__MY_BAD_SOURCE__
      if (source?.snapshot) {
        removeEventListener('my-bad:badge', found)
        resolve(source)
      }
    }
    addEventListener('my-bad:badge', found)
    found()
  })
}

function describe(report: ErrorReport, snapshot: BadgeSnapshot): Pick<DevToolsMessageEntryInput, 'message' | 'description' | 'stacktrace' | 'filePosition'> {
  const [title = '', ...rest] = report.message.split('\n')
  return {
    message: `${report.name}: ${title}`,
    description: [
      rest.join('\n').trim(),
      report.hint,
    ].filter(Boolean).join('\n\n') || where(report, snapshot),
    stacktrace: report.rawStack,
    filePosition: position(report),
  }
}

function position(report: ErrorReport): DevToolsMessageFilePosition | undefined {
  const frame = reportLocation(report)
  return frame?.file
    ? { file: frame.file, line: frame.line, column: frame.column }
    : undefined
}

function where(report: ErrorReport, snapshot: BadgeSnapshot): string | undefined {
  const frame = reportLocation(report)
  return frame?.file
    ? `${displayPath(frame, snapshot.overlay.cwd)}${frame.line === undefined
      ? ''
      : `:${frame.line}`}`
    : undefined
}

function actions(dockId: string, focus: BadgeFocus, url: string | undefined, label: string): MessageAction[] {
  const list: MessageAction[] = [
    {
      id: 'show',
      label: 'Show',
      kind: 'activate',
      activate: {
        dockId,
        params: { ...focus },
      },
    },
  ]
  const href = safeUrl(url)
  if (href) {
    list.push({
      id: 'open',
      label,
      kind: 'activate',
      activate: {
        dockId,
        params: { ...focus, open: href },
      },
    })
  }
  return list
}

function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') {
    return
  }
  try {
    const parsed = new URL(url, location.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : undefined
  }
  catch {}
}

type StorageName = 'sessionStorage' | 'localStorage'

function read<T>(storage: StorageName, key: string): T | undefined {
  try {
    return JSON.parse(window[storage].getItem(key) ?? 'null') ?? undefined
  }
  catch {}
}

function write(storage: StorageName, key: string, value: unknown): void {
  try {
    window[storage].setItem(key, JSON.stringify(value))
  }
  catch {}
}

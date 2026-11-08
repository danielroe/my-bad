import type { DevToolsMessageEntryInput, DevToolsMessageFilePosition } from '@vitejs/devtools-kit'
import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'
import type { ProblemSummary } from '../../../channel/protocol'
import type { ErrorReport } from '../../../types'
import type { BadgeFocus, BadgeSnapshot, BadgeState } from '../state'
import { displayPath } from '../../../report/path'
import { countsLabel, dockedCounts, firstLine, plural, reportLocation } from '../summary'
import { focusSender } from './frame'

type Activation = BadgeFocus & { open?: string }
type MessageAction = NonNullable<DevToolsMessageEntryInput['actions']>[number]

const PREFIX = 'my-bad:'
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

  const send = focusSender(() => ctx.current.domElements.iframe?.contentWindow)
  const show = async (focus: BadgeFocus) => {
    if (!await ctx.docks.switchEntry(dockId)) {
      ctx.panel.session.open = true
    }
    send(focus)
  }
  source.host = {
    open: focus => void show(focus),
    dock: id => void ctx.docks.switchEntry(id),
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
    send({ id: params.id, source: params.source, list: params.list })
  })

  const registration = ctx.docks.register({ ...entry }, true)
  let badge: string | undefined
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
        actions: [
          showAction(dockId, { id: current.id }),
          ...docsAction(dockId, { id: current.id }, current.docsUrl),
        ],
      })
    }

    for (const summary of snapshot.problems) {
      const failed = summary.status === 'failed'
      if (!summary.errors && !summary.warnings && !failed) {
        continue
      }
      const reports = summary.reports ?? []
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
        actions: [
          showAction(dockId, { source: summary.source }),
          ...listAction(dockId, summary),
        ],
      })
    }
    for (const id of added.keys()) {
      if (!messages.has(id)) {
        added.delete(id)
        void ctx.messages.remove(id)
      }
    }
    for (const [id, input] of messages) {
      const key = JSON.stringify(input)
      if (added.get(id) !== key) {
        added.set(id, key)
        void ctx.messages.add({ id, ...input })
      }
    }
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
    'hello',
    'error:set',
    'error:clear',
    'history',
    'warning',
    'warning:clear',
    'problems',
    'problems:clear',
    'reports',
  ]) {
    source.addEventListener(type, schedule)
  }
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

function showAction(dockId: string, focus: BadgeFocus): MessageAction {
  return {
    id: 'show',
    label: 'Show',
    kind: 'activate',
    activate: {
      dockId,
      params: { ...focus },
    },
  }
}

function docsAction(dockId: string, focus: BadgeFocus, url: string | undefined): MessageAction[] {
  const href = safeUrl(url)
  return href
    ? [
        {
          id: 'open',
          label: 'Docs',
          kind: 'activate',
          activate: {
            dockId,
            params: { ...focus, open: href },
          },
        },
      ]
    : []
}

function listAction(dockId: string, set: Pick<ProblemSummary, 'source' | 'url' | 'devtoolsDock'>): MessageAction[] {
  const activate = set.devtoolsDock
    ? { dockId: set.devtoolsDock }
    : safeUrl(set.url) && {
      dockId,
      params: { source: set.source, list: true },
    }
  return activate
    ? [
        {
          id: 'list',
          label: 'Full list',
          kind: 'activate',
          activate,
        },
      ]
    : []
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

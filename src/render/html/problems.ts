import type { ProblemSummary } from '../../channel/protocol'
import type { ErrorReport, HistoryEntry, ReportKind } from '../../types'
import type { DockedIndex, IndexView, Level } from './state'
import { plainText } from '../../report/code'
import { displayPath } from '../../report/path'
import { reportLocation } from './summary'

/** An entry of the list: a report, or a warning known only from the history. */
export type Listed = ErrorReport | HistoryEntry

export const LEVELS: Level[] = ['error', 'warning', 'info']

export function levelOf(kind: ReportKind): Level {
  return kind === 'warning' || kind === 'info'
    ? kind
    : 'error'
}

/** Keys a query can narrow the list by, besides plain words. */
export type QueryKey = 'is' | 'source' | 'file'

interface Terms {
  include: string[]
  exclude: string[]
}

/**
 * A parsed filter query. Words are ANDed, and match the name, message, code, file, level and source of an entry.
 * `-word` leaves out entries containing it. `is:`, `source:` and `file:` narrow by level, source and file; commas
 * separate alternatives, as in `is:error,warning`, and a leading `-` negates the key too.
 */
export interface Query {
  words: Terms
  is: Terms
  source: Terms
  file: Terms
}

const KEYS: QueryKey[] = ['is', 'source', 'file']
const TOKEN = /(-?)(?:([a-z]+):)?("[^"]*"?|[^\s-]\S*)/gi

function levelName(value: string): string {
  const word = value.replace(/s$/, '')
  return word === 'warn'
    ? 'warning'
    : word
}

export function parseQuery(text = ''): Query {
  const query: Query = {
    words: { include: [], exclude: [] },
    is: { include: [], exclude: [] },
    source: { include: [], exclude: [] },
    file: { include: [], exclude: [] },
  }
  for (const [, minus, rawKey, rawValue] of text.matchAll(TOKEN)) {
    const value = rawValue!.replace(/^"|"$/g, '').toLowerCase()
    const key = rawKey?.toLowerCase() as QueryKey | undefined
    const into = (terms: Terms, values: string[]) => (minus ? terms.exclude : terms.include).push(...values.filter(Boolean))
    if (key && KEYS.includes(key)) {
      const values = value.split(',')
      into(query[key], key === 'is'
        ? values.map(levelName)
        : values)
    }
    else {
      into(query.words, [
        key
          ? `${key}:${value}`
          : value,
      ])
    }
  }
  return query
}

/** Whether a view narrows the list down. */
export function filtering(view: IndexView): boolean {
  return !!view.filter?.trim()
}

/** The source an entry was listed under, for `source:` and for words to match. */
export interface ListedSource {
  source: string
  label?: string
}

function passes(terms: Terms, test: (value: string) => boolean): boolean {
  return (!terms.include.length || terms.include.some(test)) && !terms.exclude.some(test)
}

/** Whether an entry passes a query, leaving out the terms of `ignore` (to count a facet against the rest of the query). */
export function matchesQuery(entry: Listed, query: Query, cwd: string | undefined, from?: ListedSource, ignore?: QueryKey): boolean {
  const level = levelOf(entry.kind)
  const frame = 'frames' in entry
    ? reportLocation(entry)
    : undefined
  const file = frame?.file
    ? displayPath(frame, cwd).toLowerCase()
    : ''
  const sourceNames = from
    ? [from.source, from.label ?? ''].map(name => name.toLowerCase())
    : []
  if (ignore !== 'is' && !passes(query.is, value => level === value)) {
    return false
  }
  if (ignore !== 'source' && !passes(query.source, value => sourceNames.some(name => name === value || name.includes(value)))) {
    return false
  }
  if (ignore !== 'file' && !passes(query.file, value => file.includes(value))) {
    return false
  }
  const text = [
    entry.name,
    plainText(entry.message, entry.codeSpans),
    'code' in entry && entry.code,
    file,
    level,
    ...sourceNames,
  ].filter(Boolean).join('\n').toLowerCase()
  return query.words.include.every(word => text.includes(word)) && !query.words.exclude.some(word => word && text.includes(word))
}

/** Replace the `key:` token of a query with `key:value`, or drop it without a value, leaving the rest as typed. */
export function setFacet(text: string, key: QueryKey, value?: string): string {
  const parts = text.trim().split(/\s+/).filter(part => part && !part.toLowerCase().startsWith(`${key}:`))
  if (value) {
    parts.push(`${key}:${value}`)
  }
  return parts.length
    ? `${parts.join(' ')} `
    : ''
}

/** Every entry of an index, with the source it is listed under. */
function entriesOf(index: DockedIndex): Array<{ entry: Listed, from?: ListedSource }> {
  return [
    ...index.current
      ? [
          { entry: index.current },
        ]
      : [],
    ...(index.history ?? []).filter(entry => entry.kind === 'warning').map(entry => ({ entry })),
    ...index.problems.flatMap(set => (set.reports ?? []).map(entry => ({ entry, from: set }))),
  ]
}

/** What a docked view lists: everything open, and the part of it the query lets through. */
export function listing(index: DockedIndex, view: IndexView, cwd: string | undefined) {
  const query = parseQuery(view.filter)
  const narrowed = filtering(view)
  const warnings = (index.history ?? []).filter(entry => entry.kind === 'warning').reverse()
  const all: Listed[] = [
    ...index.current
      ? [index.current]
      : [],
    ...warnings,
    ...index.problems.flatMap(set => set.reports ?? []),
  ]
  return {
    all,
    current: index.current && matchesQuery(index.current, query, cwd)
      ? index.current
      : undefined,
    warnings: warnings.filter(entry => matchesQuery(entry, query, cwd)),
    sets: index.problems
      .map(set => ({
        ...set,
        ...set.reports && {
          reports: set.reports.filter(entry => matchesQuery(entry, query, cwd, set)),
        },
      }))
      .filter(set => narrowed
        ? set.reports?.length
        : set.errors + set.warnings + (set.info ?? 0) || set.status === 'failed' || set.status === 'checking'),
  }
}

/** How many entries each level and each source would list, given the rest of the query. */
export function facets(index: DockedIndex, view: IndexView, cwd: string | undefined) {
  const query = parseQuery(view.filter)
  const entries = entriesOf(index)
  return {
    levels: LEVELS.map(level => ({
      level,
      count: entries.filter(({ entry, from }) => levelOf(entry.kind) === level && matchesQuery(entry, query, cwd, from, 'is')).length,
    })),
    sources: index.problems.map(set => ({
      set,
      count: (set.reports ?? []).filter(entry => matchesQuery(entry, query, cwd, set, 'source')).length,
    })),
  }
}

/** A filter the search field offers, as the token it adds to the query. */
export interface Suggestion {
  key: QueryKey
  token: string
  /** What the user knows it by: the level, the source label or the file path. */
  label: string
  value: string
  count: number
  tone?: SourceTone
}

const SUGGESTED_FILES = 5

/**
 * What the field offers for the query as typed, grouped by key. The last word, unless the text ends in a space, is the
 * one being typed: `key:part` offers values of that key, a word that starts a key name offers that key, and any other
 * word offers the values it appears in. Counts are what each suggestion would list given the rest of the query.
 */
export function suggest(index: DockedIndex, view: IndexView, cwd: string | undefined, text: string): { base: string, negate: boolean, groups: Array<{ key: QueryKey, items: Suggestion[] }> } {
  const typing = /\S$/.test(text)
    ? text.slice(text.search(/\S+$/))
    : ''
  const base = text.slice(0, text.length - typing.length)
  const query = parseQuery(base)
  const { levels, sources } = facets(index, { ...view, filter: base }, cwd)
  const files = new Map<string, number>()
  for (const { entry, from } of entriesOf(index)) {
    const frame = 'frames' in entry
      ? reportLocation(entry)
      : undefined
    if (frame?.file && matchesQuery(entry, query, cwd, from, 'file')) {
      const path = displayPath(frame, cwd)
      files.set(path, (files.get(path) ?? 0) + 1)
    }
  }
  const quote = (value: string) => /\s/.test(value)
    ? `"${value}"`
    : value
  const all: Record<QueryKey, Suggestion[]> = {
    is: levels.filter(({ count }) => count).map(({ level, count }) => ({
      key: 'is',
      token: `is:${level}`,
      label: level,
      value: level,
      count,
    })),
    source: sources.filter(({ count, set }) => count || set.status === 'failed').map(({ set, count }) => ({
      key: 'source',
      token: `source:${quote(set.source)}`,
      label: set.label ?? set.source,
      value: set.source,
      count,
      tone: sourceTone(set),
    })),
    file: [...files].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path, count]) => ({
      key: 'file',
      token: `file:${quote(path)}`,
      label: path,
      value: path,
      count,
    })),
  }
  const picked = (item: Suggestion) => query[item.key].include.includes(item.value.toLowerCase())
  const word = typing.replace(/^-/, '').toLowerCase()
  const [, typedKey, typedValue = ''] = /^([a-z]+):(.*)$/.exec(word) ?? []
  const groups = KEYS.map((key) => {
    let items = all[key].filter(item => !picked(item))
    if (typedKey) {
      items = typedKey === key
        ? items.filter(item => item.value.toLowerCase().includes(typedValue) || item.label.toLowerCase().includes(typedValue))
        : []
    }
    else if (word && !key.startsWith(word)) {
      items = items.filter(item => item.value.toLowerCase().includes(word) || item.label.toLowerCase().includes(word))
    }
    return {
      key,
      items: key === 'file'
        ? items.slice(0, SUGGESTED_FILES)
        : items,
    }
  }).filter(group => group.items.length)
  return {
    base,
    negate: typing.startsWith('-'),
    groups,
  }
}

export type SourceTone = 'busy' | 'error' | 'warning' | 'ok'

export function sourceTone(set: ProblemSummary): SourceTone {
  return set.status === 'failed'
    ? 'error'
    : set.status === 'checking'
      ? 'busy'
      : set.errors
        ? 'error'
        : set.warnings
          ? 'warning'
          : 'ok'
}

/** What a source is doing, for example `Checking` or `Checked 3s ago`. */
export function sourceStatus(set: ProblemSummary, now: number): string {
  if (set.status === 'failed') {
    return `Failed: ${set.error || 'unknown reason'}`
  }
  if (set.status === 'checking') {
    return set.lastRun?.finishedAt === undefined
      ? 'Starting'
      : 'Checking'
  }
  return set.lastRun?.finishedAt === undefined
    ? 'Idle'
    : `Checked ${ago(set.lastRun.finishedAt, now)}`
}

/** What a source that has found nothing is doing, for example `No problems, checked 3s ago`. */
export function calmStatus(set: ProblemSummary, now: number): string {
  return set.status === 'failed' || set.status === 'checking'
    ? sourceStatus(set, now)
    : `No problems${set.lastRun?.finishedAt === undefined
      ? ''
      : `, checked ${ago(set.lastRun.finishedAt, now)}`}`
}

/** Whether nothing is open: no error, no warning, and no problem in any source. */
export function nothingOpen(index: DockedIndex): boolean {
  return !index.current && !index.history?.some(entry => entry.kind === 'warning') && index.problems.every(set => !(set.errors + set.warnings + (set.info ?? 0)))
}

function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  return seconds < 5
    ? 'just now'
    : seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : `${Math.floor(seconds / 3600)}h ago`
}

import type { CompileErrorInput, ErrorReport, Frame, ReportKind, ReportOptions, ResolvedReportOptions, Section, Snippet } from '../types'
import process from 'node:process'
import { parseRawStackTrace } from 'errx'
import { fnv1a64Base36 } from 'fnv1a-64'
import { fsLoader } from '../loaders/fs'
import { classifyFrame } from './classify'
import { externalPackage } from './package'
import { hasScheme, isFilePath, resolvePath, stripCacheQuery, toPath } from './path'
import { extractSnippet, locFromCodeFrame, locFromLabelledFrame, parseCodeFrame, stripEmbeddedFrame } from './snippet'
import { stringifyValue } from './stringify'
import { tokenizeLine } from './tokenize'

const DEFAULT_LOADERS = [fsLoader()]

export function resolveOptions(options: ReportOptions = {}): ResolvedReportOptions {
  const presets = options.presets ?? []
  return {
    cwd: options.cwd ?? (typeof process !== 'undefined' && process.cwd ? process.cwd() : '/'),
    kind: options.kind,
    loaders: options.loaders ?? [...presets.flatMap(preset => preset.loaders ?? []), ...DEFAULT_LOADERS],
    internal: [...presets.flatMap(preset => preset.internal ?? []), ...(options.internal ?? [])],
    plugins: [...presets.flatMap(preset => preset.plugins ?? []), ...(options.plugins ?? [])],
    maxCauses: options.maxCauses ?? 10,
    snippetLines: options.snippetLines ?? 5,
    snippets: options.snippets ?? true,
    context: options.context ?? {},
    tokenizer: options.tokenizer,
  }
}

/** Build a serialisable report from an error, warning, or Vite-style compile error. */
export async function createReport(input: unknown, options: ReportOptions = {}): Promise<ErrorReport> {
  const resolved = resolveOptions(options)
  const report = hoistCompileError(collapseDuplicateCauses(await buildReport(input, resolved, 0, new WeakSet())))
  for (const plugin of resolved.plugins) {
    await plugin.transform(report, { input, options: resolved })
  }
  return report
}

/**
 * Merge a wrapper that only repeats its cause's message (h3's `HTTPError`
 * around a thrown `Error`) into that cause, so the page does not show the same
 * text twice. The cause was thrown first, so its frames are the useful ones.
 */
function collapseDuplicateCauses(report: ErrorReport): ErrorReport {
  const causes = report.causes.map(collapseDuplicateCauses)
  const errors = report.errors?.map(collapseDuplicateCauses)
  const duplicate = causes.find(cause => cause.message === report.message && cause.kind === report.kind)
  if (!duplicate) {
    return { ...report, causes, ...(errors && { errors }) }
  }
  const hasApp = (frames: ErrorReport['frames']) => frames.some(frame => frame.type === 'app')
  const frames = hasApp(duplicate.frames) || !report.frames.length ? duplicate.frames : report.frames
  const generic = /^(?:Error|HTTPError|H3Error|FetchError)$/.test(report.name)
  return {
    ...report,
    name: generic && duplicate.name !== 'Error' ? duplicate.name : report.name,
    code: report.code ?? duplicate.code,
    hint: report.hint ?? duplicate.hint,
    docsUrl: report.docsUrl ?? duplicate.docsUrl,
    status: report.status ?? duplicate.status,
    trace: report.trace ?? duplicate.trace,
    frames,
    rawStack: report.rawStack ?? duplicate.rawStack,
    sections: mergeSections(report.sections, duplicate.sections),
    causes: [...causes.filter(cause => cause !== duplicate), ...duplicate.causes],
    ...(errors && { errors }),
  }
}

/** Frameworks wrap compiler errors in generic HTTP errors; the compile error is what the developer needs first. */
function hoistCompileError(report: ErrorReport): ErrorReport {
  if (report.kind !== 'error' || report.frames.some(frame => frame.type === 'app')) {
    return report
  }
  const index = report.causes.findIndex(cause => cause.kind === 'compile')
  if (index === -1) {
    return report
  }
  const compile = report.causes[index]!
  const wrapper: ErrorReport = { ...report, causes: report.causes.filter((_, i) => i !== index) }
  return {
    ...compile,
    status: compile.status ?? report.status,
    sections: mergeSections(compile.sections, report.sections),
    causes: [...compile.causes, wrapper],
  }
}

function mergeSections(base: Section[], extra: Section[]): Section[] {
  return [...base, ...extra.filter(section => !base.some(existing => existing.id === section.id))]
}

async function buildReport(input: unknown, options: ResolvedReportOptions, depth: number, seen: WeakSet<object>): Promise<ErrorReport> {
  const error = normalizeInput(input)
  const isObject = typeof input === 'object' && input !== null
  if (isObject) {
    seen.add(input)
  }

  const kind = options.kind ?? (isCompileInput(input) ? 'compile' : 'error')
  const frames = await buildFrames(input, error, options, kind)

  const sections: Section[] = []
  if (error.data !== undefined) {
    sections.push({ id: 'data', title: 'Data', content: toSectionContent(error.data) })
  }

  const report: ErrorReport = {
    id: '',
    kind,
    name: error.name,
    message: kind === 'compile' ? stripEmbeddedFrame(error.message) : error.message,
    ...(error.code && { code: error.code }),
    ...(error.status && { status: error.status }),
    frames,
    causes: [],
    sections,
    ...(error.stack && { rawStack: error.stack }),
    timestamp: Date.now(),
  }

  if (depth < options.maxCauses) {
    if (error.cause !== undefined && !(typeof error.cause === 'object' && error.cause !== null && seen.has(error.cause))) {
      report.causes.push(await buildReport(error.cause, { ...options, kind: undefined }, depth + 1, seen))
    }
    if (Array.isArray(error.errors)) {
      report.errors = []
      for (const nested of error.errors) {
        if (typeof nested === 'object' && nested !== null && seen.has(nested)) {
          continue
        }
        report.errors.push(await buildReport(nested, { ...options, kind: undefined }, depth + 1, seen))
      }
    }
  }

  if (isObject) {
    seen.delete(input)
  }

  const top = frames.find(frame => frame.type === 'app') ?? frames[0]
  report.id = fnv1a64Base36(`${report.name}\n${report.message}\n${top?.file ?? ''}:${top?.line ?? ''}`)
  return report
}

interface NormalizedError {
  name: string
  message: string
  stack?: string
  code?: string
  status?: number
  data?: unknown
  cause?: unknown
  errors?: unknown
}

function normalizeInput(input: unknown): NormalizedError {
  if (input instanceof Error || (typeof input === 'object' && input !== null && 'message' in input)) {
    const error = input as Error & Record<string, unknown>
    const status = error.statusCode ?? error.status
    return {
      name: typeof error.name === 'string' && error.name ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : String(error.message),
      stack: typeof error.stack === 'string' ? error.stack : undefined,
      code: typeof error.code === 'string' ? error.code : undefined,
      status: typeof status === 'number' ? status : undefined,
      data: error.data,
      cause: error.cause,
      errors: error.errors,
    }
  }
  return { name: 'Error', message: stringifyValue(input, 2) }
}

function isCompileInput(input: unknown): input is CompileErrorInput {
  if (typeof input !== 'object' || input === null) {
    return false
  }
  const candidate = input as CompileErrorInput
  return compileLoc(candidate) !== undefined || typeof candidate.frame === 'string'
}

function compileLoc(input: CompileErrorInput): { file?: string, line: number, column: number } | undefined {
  const loc = input.loc
  if (typeof loc !== 'object' || loc === null) {
    return
  }
  if ('start' in loc && typeof loc.start?.line === 'number') {
    return { file: loc.file, line: loc.start.line, column: loc.start.column }
  }
  if ('line' in loc && typeof loc.line === 'number') {
    return loc
  }
}

async function buildFrames(input: unknown, error: NormalizedError, options: ResolvedReportOptions, kind: ReportKind): Promise<Frame[]> {
  if (kind === 'compile' && isCompileInput(input)) {
    const labelled = locFromLabelledFrame(`${input.frame ?? ''}\n${input.message}`)
    const loc = compileLoc(input) ?? (typeof input.frame === 'string' ? locFromCodeFrame(input.frame) : undefined) ?? labelled
    const file = (loc as { file?: string } | undefined)?.file ?? input.id ?? (labelled && resolvePath(options.cwd, labelled.file))
    const frame: Frame = {
      ...(file && { file: stripCacheQuery(toPath(isFilePath(file) || hasScheme(file) ? file : resolvePath(options.cwd, file))) }),
      ...(loc && { line: loc.line, column: loc.column }),
      type: 'app',
      ...(input.frame && { snippet: parseCodeFrame(input.frame) }),
    }
    if (!frame.snippet && frame.file && frame.line !== undefined && options.snippets) {
      frame.snippet = await loadSnippet(frame.file, frame.line, options)
    }
    else if (frame.snippet) {
      frame.snippet = withTokens(frame.snippet, options)
    }
    addDisplayPaths(frame, options.cwd)
    return [frame]
  }

  if (!error.stack) {
    return []
  }

  const parsed = parseRawStackTrace(error.stack)
  const frames: Frame[] = []
  for (const trace of parsed) {
    let frame: Frame = {
      ...(trace.source && !trace.isNative && { file: stripCacheQuery(toPath(trace.source)) }),
      ...(trace.line !== undefined && { line: trace.line }),
      ...(trace.column !== undefined && { column: trace.column }),
      ...(trace.function && { function: trace.function }),
      type: 'native',
      ...(trace.isAsync && { isAsync: true }),
      ...(trace.isConstructor && { isConstructor: true }),
      ...(trace.isEval && { isEval: true }),
      ...('raw' in trace && typeof trace.raw === 'string' && { raw: trace.raw }),
    }
    frame.type = classifyFrame({ ...frame, isNative: trace.isNative }, options.internal, packageName(frame.file, options.cwd))

    if (frame.type !== 'native') {
      const mapped = await mapFrame(frame, options)
      const forcedVendor = mapped !== frame && mapped.type === 'vendor' && frame.type !== 'vendor'
      frame = mapped
      frame.type = forcedVendor ? 'vendor' : classifyFrame(frame, options.internal, packageName(frame.file, options.cwd))
      if (options.snippets && frame.type === 'app' && frame.file && frame.line !== undefined) {
        frame.snippet = await loadSnippet(frame.file, frame.line, options)
        if (frame.compiled?.line !== undefined) {
          const compiled = await loadCompiledSnippet(frame.compiled.file, frame.compiled.line, options, frame.compiled.file !== frame.file)
          if (compiled) {
            frame.compiled = { ...frame.compiled, snippet: compiled }
          }
        }
      }
    }
    addDisplayPaths(frame, options.cwd)
    frames.push(frame)
  }
  return frames
}

function packageName(file: string | undefined, cwd: string): string | undefined {
  return file ? externalPackage(file, cwd)?.name : undefined
}

/**
 * Resolve display paths while the filesystem is available: renderers, including
 * the browser client, only ever see the resulting strings.
 */
function addDisplayPaths(frame: Frame, cwd: string): void {
  const own = frame.file ? externalPackage(frame.file, cwd)?.displayFile : undefined
  if (own) {
    frame.displayFile = own
  }
  const compiled = frame.compiled ? externalPackage(frame.compiled.file, cwd)?.displayFile : undefined
  if (compiled) {
    frame.compiled = { ...frame.compiled!, displayFile: compiled }
  }
}

async function mapFrame(frame: Frame, options: ResolvedReportOptions): Promise<Frame> {
  for (const loader of options.loaders) {
    if (!loader.map) {
      continue
    }
    try {
      const result = await loader.map(frame)
      if (result === false) {
        return frame
      }
      if (result) {
        return result
      }
    }
    catch {}
  }
  return frame
}

async function loadSnippet(file: string, line: number, options: ResolvedReportOptions) {
  for (const loader of options.loaders) {
    if (!loader.read) {
      continue
    }
    try {
      const contents = await loader.read(file)
      if (contents !== undefined) {
        return withTokens(extractSnippet(contents, line, options.snippetLines, file), options)
      }
    }
    catch {}
  }
}

/**
 * Read generated code through `readCompiled`, falling back to `read` only when
 * the compiled location is a separate file: when it shares the source path
 * (module runners) the code lives in memory and only `readCompiled` has it.
 */
async function loadCompiledSnippet(file: string, line: number, options: ResolvedReportOptions, separateFile: boolean) {
  for (const loader of options.loaders) {
    try {
      const contents = await loader.readCompiled?.(file)
      if (contents !== undefined) {
        return withTokens(extractSnippet(contents, line, options.snippetLines, file), options)
      }
    }
    catch {}
  }
  return separateFile ? loadSnippet(file, line, options) : undefined
}

function withTokens<T extends Snippet | undefined>(snippet: T, options: ResolvedReportOptions): T {
  if (!snippet || !options.tokenizer) {
    return snippet
  }
  const tokens = snippet.lines.map(line => tokenizeLine(line, snippet.lang, options.tokenizer))
  return { ...snippet, tokens }
}

function toSectionContent(data: unknown): Record<string, unknown> | string {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return stringifyValue(data, 2)
}

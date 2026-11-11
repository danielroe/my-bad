import type { ErrorReport, Frame, Snippet } from '../../types'
import type { Palette } from './style'
import process from 'node:process'
import { hyperlink, link } from 'clickable-path'
import { stripAnsi as clean } from '../../report/ansi'
import { codeSpans } from '../../report/code'
import { clampMessage, DEFAULT_DISPLAY_MESSAGE_LENGTH, splitHeadline } from '../../report/message'
import { displayPath, isFilePath } from '../../report/path'
import { stringifyValue } from '../../report/stringify'
import { snippetTokens } from '../../report/tokenize'
import { groupFrames, groupSummary } from '../frames'
import { createPalette, detectAnsiEnv, truncateMiddle, wrap } from './style'

export interface RenderAnsiOptions {
  cwd?: string
  /** Defaults to the terminal width, or 80. */
  width?: number
  /** Override colour detection. */
  colors?: boolean
  /** Override OSC 8 hyperlink detection. */
  hyperlinks?: boolean
  /** Expand vendor/native frames and print sections. */
  verbose?: boolean
  /** Lines of snippet context to show around the error line. Default 2. */
  snippetContext?: number
  /** Leading `✖` / `⚠` glyph. Disable when a logger such as consola already prints a badge. Default `true`. */
  icon?: boolean
  /** Characters of each message printed before the rest is summarised. Default `1000`. */
  maxMessageLength?: number
}

interface Ctx {
  p: Palette
  hyperlinks: boolean
  cwd: string
  width: number
  verbose: boolean
  snippetContext: number
  icon: boolean
  maxMessageLength: number
}

export function renderAnsi(report: ErrorReport, options: RenderAnsiOptions = {}): string {
  const env = detectAnsiEnv()
  const hyperlinks = options.hyperlinks ?? env.hyperlinks
  const ctx: Ctx = {
    p: createPalette({ colors: options.colors ?? env.colors, hyperlinks }),
    hyperlinks,
    cwd: options.cwd ?? process.cwd(),
    width: Math.max(40, options.width ?? process.stderr.columns ?? 80),
    verbose: options.verbose ?? false,
    snippetContext: options.snippetContext ?? 2,
    icon: options.icon ?? true,
    maxMessageLength: options.maxMessageLength ?? DEFAULT_DISPLAY_MESSAGE_LENGTH,
  }
  return renderReport(report, ctx, 0).join('\n')
}

function renderReport(report: ErrorReport, ctx: Ctx, depth: number): string[] {
  const { p } = ctx
  const out: string[] = []
  const indent = '  '.repeat(depth)
  const width = ctx.width - indent.length

  const tone = report.kind === 'warning'
    ? p.yellow
    : report.kind === 'info'
      ? p.blue
      : p.red
  const icon = tone(report.kind === 'warning'
    ? '⚠'
    : report.kind === 'info'
      ? 'ℹ'
      : '✖')
  const name = tone(p.bold(clean(report.name)))
  const status = finite(report.status)
  const meta = [report.code !== report.name && report.code && p.dim(`[${clean(report.code)}]`), status && p.dim(`(${status})`)].filter(Boolean).join(' ')
  const header = depth === 0
    ? (ctx.icon
        ? `${icon} ${name}`
        : name)
    : `${p.dim('Caused by:')} ${name}`
  const title = `${header}${meta
    ? ` ${meta}`
    : ''}${p.dim(':')} `
  const { head, rest } = clampMessage(clean(report.message), ctx.maxMessageLength)
  const { headline, body } = splitHeadline(rest
    ? `${head}…`
    : head.trimEnd())
  const messageLines = wrap(styleCode(headline, report.codeSpans, p), width - 2, '')
  out.push(`${indent}${title}${p.bold(messageLines[0] ?? '')}`)
  for (const line of messageLines.slice(1)) {
    out.push(`${indent}  ${p.bold(line)}`)
  }
  if (body) {
    for (const line of wrap(styleCode(body, report.codeSpans, p), width - 2, '')) {
      out.push(`${indent}  ${line}`)
    }
  }
  if (rest) {
    out.push(`${indent}  ${p.dim(`${rest.length} more characters`)}`)
  }

  if (report.hint) {
    out.push('')
    for (const [index, line] of wrap(styleCode(clean(report.hint), report.codeSpans, p), width - 4).entries()) {
      out.push(`${indent}  ${index === 0
        ? p.cyan('ℹ')
        : ' '} ${line}`)
    }
  }
  if (report.docsUrl) {
    const docsUrl = clean(report.docsUrl)
    out.push(`${indent}  ${p.dim('→')} ${hyperlink(p.underline(p.cyan(docsUrl)), docsUrl, { enabled: ctx.hyperlinks })}`)
  }

  if (report.trace?.length) {
    out.push('')
    const crumbs = report.trace.map(entry => clean(entry.label)).join(p.dim(' › '))
    out.push(`${indent}  ${truncateMiddle(crumbs, width - 2)}`)
  }

  const topApp = report.frames.find(frame => frame.type === 'app' && frame.snippet)
  if (topApp?.snippet && topApp.line !== undefined) {
    out.push('')
    out.push(...renderSnippet(topApp.snippet, topApp.line, topApp.column, ctx, `${indent}  `, topApp.endLine === undefined || topApp.endLine === topApp.line
      ? finite(topApp.endColumn)
      : undefined))
  }
  else {
    const generated = report.frames.find(frame => frame.type === 'app' && frame.compiled?.snippet && frame.compiled.line !== undefined)?.compiled
    if (generated?.snippet && generated.line !== undefined) {
      out.push('', `${indent}  ${p.dim('generated code:')}`)
      out.push(...renderSnippet(generated.snippet, generated.line, generated.column, ctx, `${indent}  `))
    }
  }

  if (report.frames.length) {
    out.push('')
    out.push(...renderFrames(report.frames, ctx, `${indent}  `))
  }
  if (report.related?.length) {
    out.push('', `${indent}  ${p.dim('Also in:')}`)
    for (const entry of report.related) {
      out.push(`${indent}    ${p.cyan(renderPath(entry, ctx, width - 4))}`)
    }
  }

  if (ctx.verbose && report.sections.length) {
    for (const section of report.sections) {
      out.push('', `${indent}  ${p.bold(clean(section.title))}`)
      if (typeof section.content === 'string') {
        for (const line of clean(section.content).split('\n')) {
          out.push(`${indent}    ${line}`)
        }
      }
      else {
        for (const [key, value] of Object.entries(section.content)) {
          out.push(`${indent}    ${p.dim(clean(key))} ${clean(stringifyValue(value))}`)
        }
      }
    }
  }

  for (const cause of visibleCauses(report)) {
    out.push('')
    out.push(...renderReport(cause, ctx, depth + 1))
  }
  if (report.errors?.length) {
    for (const [index, nested] of report.errors.entries()) {
      out.push('', `${indent}  ${p.dim(`[${index + 1}/${report.errors.length}]`)}`)
      out.push(...renderReport(nested, ctx, depth + 1))
    }
  }
  const omitted = finite(report.omittedErrors)
  if (omitted) {
    out.push('', `${indent}  ${p.dim(`… and ${omitted} more`)}`)
  }

  return out
}

/** Code spans lose their backticks and take a colour, word by word so that wrapping keeps each word styled. */
function styleCode(text: string, spans: boolean | undefined, p: Palette): string {
  return spans && text.includes('`')
    ? codeSpans(text).map(segment => segment.code
        ? segment.text.split(' ').map(word => word && p.cyan(word)).join(' ')
        : segment.text).join('')
    : text
}

/** Skip a cause that only repeats its parent's message, keeping whatever it wraps. */
function visibleCauses(report: ErrorReport): ErrorReport[] {
  return report.causes.flatMap(cause => cause.message === report.message && !cause.errors?.length && !cause.omittedErrors
    ? visibleCauses(cause)
    : [cause])
}

function renderFrames(frames: Frame[], ctx: Ctx, indent: string): string[] {
  const { p } = ctx
  const out: string[] = []
  for (const entry of groupFrames(frames)) {
    if ('app' in entry) {
      out.push(renderFrame(entry.app, ctx, indent, false))
    }
    else if (ctx.verbose) {
      out.push(...entry.group.map(({ frame }) => renderFrame(frame, ctx, indent, true)))
    }
    else {
      out.push(`${indent}${p.dim(`… ${groupSummary(entry.group.map(({ frame }) => frame))}`)}`)
    }
  }
  return out
}

function renderFrame(frame: Frame, ctx: Ctx, indent: string, dim: boolean): string {
  const { p } = ctx
  const prefix = [frame.isAsync && 'async', frame.isConstructor && 'new'].filter(Boolean).join(' ')
  const fn = clean(frame.function ?? (frame.isEval ? 'eval' : '<anonymous>'))
  const line = finite(frame.line)
  const column = finite(frame.column)
  const generatedLine = finite(frame.compiled?.line)
  const generatedColumn = finite(frame.compiled?.column)
  const location = clean(frame.file
    ? `${displayPath(frame, ctx.cwd)}${line !== undefined
      ? `:${line}${column !== undefined
        ? `:${column}`
        : ''}`
      : ''}`
    : frame.raw?.trim().replace(/^at\s+/, '') ?? '')
  const available = ctx.width - indent.length - 4 - fn.length - (prefix
    ? prefix.length + 1
    : 0)
  const shown = truncateMiddle(location, Math.max(20, available))
  const linked = frame.file && isFilePath(frame.file)
    ? link(frame.file, {
        cwd: ctx.cwd,
        line,
        column,
        enabled: ctx.hyperlinks,
        formatter: () => shown,
      })
    : shown
  const note = line === undefined && generatedLine !== undefined
    ? ` ${p.dim(`(generated ${generatedLine}${generatedColumn !== undefined
      ? `:${generatedColumn}`
      : ''})`)}`
    : ''
  const text = `${p.dim('at')} ${prefix
    ? `${p.dim(prefix)} `
    : ''}${dim
    ? fn
    : p.bold(fn)} ${dim
    ? linked
    : p.cyan(linked)}${note}`
  return `${indent}${dim
    ? p.dim(text)
    : text}`
}

function renderPath(target: Pick<Frame, 'file' | 'displayFile' | 'line' | 'column'>, ctx: Ctx, max: number): string {
  const line = finite(target.line)
  const column = finite(target.column)
  const shown = truncateMiddle(clean(`${displayPath(target, ctx.cwd)}${line !== undefined
    ? `:${line}${column !== undefined
      ? `:${column}`
      : ''}`
    : ''}`), Math.max(20, max))
  return target.file && isFilePath(target.file)
    ? link(target.file, {
        cwd: ctx.cwd,
        line,
        column,
        enabled: ctx.hyperlinks,
        formatter: () => shown,
      })
    : shown
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function renderSnippet(snippet: Snippet, line: number, column: number | undefined, ctx: Ctx, indent: string, endColumn?: number): string[] {
  const { p } = ctx
  const out: string[] = []
  const first = Math.max(snippet.start, line - ctx.snippetContext)
  const last = Math.min(snippet.start + snippet.lines.length - 1, line + ctx.snippetContext)
  const gutter = String(last).length
  const codeWidth = ctx.width - indent.length - gutter - 5
  for (let n = first; n <= last; n++) {
    const raw = clean(snippet.lines[n - snippet.start] ?? '')
    const code = raw.length > codeWidth
      ? `${raw.slice(0, codeWidth - 1)}…`
      : (n === line
          ? colorTokens(snippet, n - snippet.start, p)
          : raw)
    const number = String(n).padStart(gutter)
    if (n === line) {
      out.push(`${indent}${p.red('›')} ${p.red(p.bold(number))} ${p.dim('│')} ${code}`)
      const shown = column === undefined
        ? undefined
        : column - (snippet.offset ?? 0)
      if (shown !== undefined && shown > 0 && shown <= codeWidth) {
        const width = endColumn === undefined || column === undefined
          ? 1
          : Math.min(Math.max(1, endColumn - column), codeWidth - shown + 1, Math.max(1, raw.length - shown + 1))
        out.push(`${indent}  ${' '.repeat(gutter)} ${p.dim('│')} ${' '.repeat(shown - 1)}${p.red('^'.repeat(width))}`)
      }
    }
    else {
      out.push(`${indent}  ${p.dim(number)} ${p.dim('│')} ${p.dim(code)}`)
    }
  }
  return out
}

function colorTokens(snippet: Snippet, index: number, p: Palette): string {
  return snippetTokens(snippet, index).map((token) => {
    const text = clean(token.text)
    switch (token.type) {
      case 'keyword': return p.magenta(text)
      case 'string': return p.green(text)
      case 'number':
      case 'attribute': return p.yellow(text)
      case 'comment': return p.dim(text)
      case 'function':
      case 'variable': return p.blue(text)
      case 'type': return p.yellow(text)
      case 'tag': return p.red(text)
      default: return text
    }
  }).join('')
}

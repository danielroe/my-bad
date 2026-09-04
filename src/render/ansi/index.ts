import type { ErrorReport, Frame, Snippet } from '../../types'
import type { Palette } from './style'
import process from 'node:process'
import { hyperlink, link } from 'clickable-path'
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
}

interface Ctx {
  p: Palette
  hyperlinks: boolean
  cwd: string
  width: number
  verbose: boolean
  snippetContext: number
  icon: boolean
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
  }
  return renderReport(report, ctx, 0).join('\n')
}

function renderReport(report: ErrorReport, ctx: Ctx, depth: number): string[] {
  const { p } = ctx
  const out: string[] = []
  const indent = '  '.repeat(depth)
  const width = ctx.width - indent.length

  const icon = report.kind === 'warning' ? p.yellow('⚠') : p.red('✖')
  const name = report.kind === 'warning' ? p.yellow(p.bold(report.name)) : p.red(p.bold(report.name))
  const meta = [report.code && p.dim(`[${report.code}]`), report.status && p.dim(`(${report.status})`)].filter(Boolean).join(' ')
  const header = depth === 0 ? (ctx.icon ? `${icon} ${name}` : name) : `${p.dim('Caused by:')} ${name}`
  const title = `${header}${meta ? ` ${meta}` : ''}${p.dim(':')} `
  const messageLines = wrap(report.message, width - 2, '')
  out.push(`${indent}${title}${p.bold(messageLines[0] ?? '')}`)
  for (const line of messageLines.slice(1)) {
    out.push(`${indent}  ${p.bold(line)}`)
  }

  if (report.hint) {
    out.push('')
    for (const [index, line] of wrap(report.hint, width - 4).entries()) {
      out.push(`${indent}  ${index === 0 ? p.cyan('ℹ') : ' '} ${line}`)
    }
  }
  if (report.docsUrl) {
    out.push(`${indent}  ${p.dim('→')} ${hyperlink(p.underline(p.cyan(report.docsUrl)), report.docsUrl, { enabled: ctx.hyperlinks })}`)
  }

  if (report.trace?.length) {
    out.push('')
    const crumbs = report.trace.map(entry => entry.label).join(p.dim(' › '))
    out.push(`${indent}  ${truncateMiddle(crumbs, width - 2)}`)
  }

  const topApp = report.frames.find(frame => frame.type === 'app' && frame.snippet)
  if (topApp?.snippet && topApp.line !== undefined) {
    out.push('')
    out.push(...renderSnippet(topApp.snippet, topApp.line, topApp.column, ctx, `${indent}  `))
  }

  if (report.frames.length) {
    out.push('')
    out.push(...renderFrames(report.frames, ctx, `${indent}  `))
  }

  if (ctx.verbose && report.sections.length) {
    for (const section of report.sections) {
      out.push('', `${indent}  ${p.bold(section.title)}`)
      if (typeof section.content === 'string') {
        for (const line of section.content.split('\n')) {
          out.push(`${indent}    ${line}`)
        }
      }
      else {
        for (const [key, value] of Object.entries(section.content)) {
          out.push(`${indent}    ${p.dim(key)} ${stringifyValue(value)}`)
        }
      }
    }
  }

  for (const cause of report.causes) {
    out.push('')
    out.push(...renderReport(cause, ctx, depth + 1))
  }
  if (report.errors?.length) {
    for (const [index, nested] of report.errors.entries()) {
      out.push('', `${indent}  ${p.dim(`[${index + 1}/${report.errors.length}]`)}`)
      out.push(...renderReport(nested, ctx, depth + 1))
    }
  }

  return out
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
  const fn = frame.function ?? (frame.isEval ? 'eval' : '<anonymous>')
  const location = frame.file
    ? `${displayPath(frame, ctx.cwd)}${frame.line !== undefined ? `:${frame.line}${frame.column !== undefined ? `:${frame.column}` : ''}` : ''}`
    : frame.raw?.trim().replace(/^at\s+/, '') ?? ''
  const available = ctx.width - indent.length - 4 - fn.length - (prefix ? prefix.length + 1 : 0)
  const shown = truncateMiddle(location, Math.max(20, available))
  const linked = frame.file && isFilePath(frame.file)
    ? link(frame.file, { cwd: ctx.cwd, line: frame.line, column: frame.column, enabled: ctx.hyperlinks, formatter: () => shown })
    : shown
  const text = `${p.dim('at')} ${prefix ? `${p.dim(prefix)} ` : ''}${dim ? fn : p.bold(fn)} ${dim ? linked : p.cyan(linked)}`
  return `${indent}${dim ? p.dim(text) : text}`
}

function renderSnippet(snippet: Snippet, line: number, column: number | undefined, ctx: Ctx, indent: string): string[] {
  const { p } = ctx
  const out: string[] = []
  const first = Math.max(snippet.start, line - ctx.snippetContext)
  const last = Math.min(snippet.start + snippet.lines.length - 1, line + ctx.snippetContext)
  const gutter = String(last).length
  const codeWidth = ctx.width - indent.length - gutter - 5
  for (let n = first; n <= last; n++) {
    const raw = snippet.lines[n - snippet.start] ?? ''
    const code = raw.length > codeWidth ? `${raw.slice(0, codeWidth - 1)}…` : (n === line ? colorTokens(snippet, n - snippet.start, p) : raw)
    const number = String(n).padStart(gutter)
    if (n === line) {
      out.push(`${indent}${p.red('›')} ${p.red(p.bold(number))} ${p.dim('│')} ${code}`)
      if (column !== undefined && column > 0 && column <= codeWidth) {
        out.push(`${indent}  ${' '.repeat(gutter)} ${p.dim('│')} ${' '.repeat(column - 1)}${p.red('^')}`)
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
    switch (token.type) {
      case 'keyword': return p.magenta(token.text)
      case 'string': return p.green(token.text)
      case 'number':
      case 'attribute': return p.yellow(token.text)
      case 'comment': return p.dim(token.text)
      case 'function':
      case 'variable': return p.blue(token.text)
      case 'type': return p.yellow(token.text)
      case 'tag': return p.red(token.text)
      default: return token.text
    }
  }).join('')
}

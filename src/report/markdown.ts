import type { ErrorReport, Frame } from '../types'
import { relativeToCwd } from './path'
import { stringifyValue } from './stringify'

export interface MarkdownOptions {
  cwd?: string
  /** Include collapsed vendor/native frames. Default `false`. */
  allFrames?: boolean
}

/** Render a report as Markdown suitable for a GitHub issue or an agent prompt. */
export function toMarkdown(report: ErrorReport, options: MarkdownOptions = {}): string {
  return render(report, options, 2).join('\n')
}

function render(report: ErrorReport, options: MarkdownOptions, level: number): string[] {
  const h = '#'.repeat(Math.min(level, 6))
  const out: string[] = []
  const label = report.kind === 'warning' ? 'Warning' : report.kind === 'compile' ? 'Compile error' : 'Error'
  out.push(`${h} ${label}: ${report.name}${report.code ? ` [${report.code}]` : ''}`, '')
  out.push('```', report.message, '```', '')
  if (report.hint) {
    out.push(`> ${report.hint}`, '')
  }
  if (report.docsUrl) {
    out.push(`Docs: ${report.docsUrl}`, '')
  }
  if (report.trace?.length) {
    out.push(`Component trace: ${report.trace.map(entry => `\`${entry.label}\``).join(' › ')}`, '')
  }

  const top = report.frames.find(frame => frame.type === 'app' && frame.snippet)
  if (top?.snippet && top.file) {
    out.push(`\`${loc(top, options)}\``, '')
    out.push(`\`\`\`${top.snippet.lang ?? ''}`)
    for (const [index, line] of top.snippet.lines.entries()) {
      const n = top.snippet.start + index
      out.push(`${n === top.line ? '>' : ' '} ${String(n).padStart(String(top.snippet.start + top.snippet.lines.length).length)} | ${line}`)
    }
    out.push('```', '')
  }

  if (report.frames.length) {
    out.push('```')
    let hidden = 0
    for (const frame of report.frames) {
      if (frame.type !== 'app' && !options.allFrames) {
        hidden++
        continue
      }
      if (hidden) {
        out.push(`    ... ${hidden} more`)
        hidden = 0
      }
      out.push(`    at ${[frame.isAsync && 'async', frame.isConstructor && 'new', frame.function ?? '<anonymous>'].filter(Boolean).join(' ')} (${loc(frame, options)})`)
    }
    if (hidden) {
      out.push(`    ... ${hidden} more`)
    }
    out.push('```', '')
  }

  for (const section of report.sections) {
    if (section.id === 'headers') {
      continue
    }
    out.push(`**${section.title}**`, '')
    if (typeof section.content === 'string') {
      out.push('```', section.content, '```', '')
    }
    else {
      for (const [key, value] of Object.entries(section.content)) {
        out.push(`- ${key}: \`${stringifyValue(value)}\``)
      }
      out.push('')
    }
  }

  for (const cause of report.causes) {
    out.push(...render({ ...cause, name: `Caused by ${cause.name}` }, options, level + 1))
  }
  for (const nested of report.errors ?? []) {
    out.push(...render(nested, options, level + 1))
  }
  return out
}

function loc(frame: Frame, options: MarkdownOptions): string {
  const file = frame.file ? (options.cwd ? relativeToCwd(frame.file, options.cwd) : frame.file) : (frame.raw?.trim() ?? '<anonymous>')
  return `${file}${frame.line !== undefined ? `:${frame.line}` : ''}${frame.column !== undefined ? `:${frame.column}` : ''}`
}

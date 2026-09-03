import type { Color, Style } from 'ansivision'
import { renderString } from 'ansivision'

/** ANSI palette chosen to match the HTML theme's syntax tokens, so both assets read as one product. */
const PALETTE = ['#09090b', '#fca5a5', '#86efac', '#fde68a', '#93c5fd', '#c4b5fd', '#7dd3fc', '#f4f4f5']
const BG = '#09090b'
const FG = '#f4f4f5'
const CELL = 8.4
const LINE = 20
const PADDING = 20

function color(value: Color | null): string | undefined {
  if (value === null) {
    return
  }
  return typeof value === 'number' ? PALETTE[value % 8] : `rgb(${value.join(' ')})`
}

function escapeXml(text: string): string {
  return text.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;')
}

function attrs(style: Style): string {
  const fill = color(style.foreground)
  return [
    fill && fill !== FG && `fill="${fill}"`,
    style.bold && 'font-weight="600"',
    style.italic && 'font-style="italic"',
    style.dim && 'opacity="0.6"',
    style.underline && 'text-decoration="underline"',
  ].filter(Boolean).join(' ')
}

/** Group each row's cells into runs of one style, so a row is a handful of `tspan`s rather than one per character. */
function row(text: string, styles: Style[]): string {
  const runs: Array<{ style: Style, text: string }> = []
  for (const [index, char] of [...text].entries()) {
    const style = styles[index] ?? styles[styles.length - 1]!
    const last = runs[runs.length - 1]
    if (last && attrs(last.style) === attrs(style)) {
      last.text += char
    }
    else {
      runs.push({ style, text: char })
    }
  }
  return runs.map(({ style, text }) => {
    const applied = attrs(style)
    // `xml:space` keeps the leading indentation of gutters and stack frames.
    return applied ? `<tspan ${applied} xml:space="preserve">${escapeXml(text)}</tspan>` : `<tspan xml:space="preserve">${escapeXml(text)}</tspan>`
  }).join('')
}

export async function ansiSvg(output: string): Promise<string> {
  const rendered = await renderString(output)
  const { contents, styles } = rendered.frameObjects.at(-1)!
  const lines = contents.replace(/\s+$/, '').split('\n')
  const width = Math.round(Math.max(...lines.map(line => [...line].length)) * CELL + PADDING * 2)
  const height = lines.length * LINE + PADDING * 2
  const rows = lines.map((line, index) => `<text x="${PADDING}" y="${PADDING + LINE * index + 14}">${row(line, styles[index] ?? [])}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13.5" fill="${FG}">
<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>
${rows.join('\n')}
</svg>
`
}

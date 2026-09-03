import process from 'node:process'
import { styleText } from 'node:util'
import { supportsHyperlinks } from 'clickable-path'

export interface AnsiEnv {
  colors: boolean
  hyperlinks: boolean
}

export function detectAnsiEnv(stream: { isTTY?: boolean } = process.stderr): AnsiEnv {
  const env = process.env
  let colors: boolean
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    colors = false
  }
  else if (env.FORCE_COLOR !== undefined) {
    colors = env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  }
  else {
    colors = !!stream.isTTY && env.TERM !== 'dumb'
  }
  return { colors, hyperlinks: colors && supportsHyperlinks(stream) }
}

type Styler = (text: string) => string

const STYLES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'dim', 'bold', 'underline'] as const

export type Palette = { [K in typeof STYLES[number]]: Styler }

const identity: Styler = text => text

export function createPalette(env: AnsiEnv): Palette {
  const palette = {} as Palette
  for (const style of STYLES) {
    // `styleText` would otherwise validate `process.stdout`, which is neither the stream we render to nor the caller's `colors` choice
    palette[style] = env.colors ? text => styleText(style, text, { validateStream: false }) : identity
  }
  return palette
}

/** OSC 8 payloads can contain commas, which `util.stripVTControlCharacters` mangles. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*m|\u001B\]8;;.*?(?:\u0007|\u001B\\)/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length
}

/** Truncate the middle of a string to fit within `max` visible characters. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max || max < 5) {
    return text
  }
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (line && visibleWidth(line) + 1 + word.length > width) {
        out.push(line)
        line = indent + word
      }
      else {
        line = line ? `${line} ${word}` : word
      }
    }
    out.push(line)
  }
  return out
}

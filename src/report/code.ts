export interface TextSegment {
  text: string
  /** Contents of a code span, without its backticks. */
  code?: true
}

/** Split text at CommonMark code spans. A backtick run with no later run of the same length stays literal. */
export function codeSpans(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  const unmatched = new Set<number>()
  let last = 0
  let index = text.indexOf('`')
  while (index !== -1) {
    const open = runEnd(text, index)
    const size = open - index
    const close = unmatched.has(size)
      ? -1
      : closingRun(text, open, size)
    if (close === -1) {
      unmatched.add(size)
      index = text.indexOf('`', open)
      continue
    }
    if (index > last) {
      segments.push({
        text: text.slice(last, index),
      })
    }
    segments.push({
      text: spanContent(text.slice(open, close)),
      code: true,
    })
    last = close + size
    index = text.indexOf('`', last)
  }
  if (last < text.length) {
    segments.push({
      text: text.slice(last),
    })
  }
  return segments
}

/** `text` with the delimiters of its code spans removed, when it has any. */
export function plainText(text: string, spans: boolean | undefined): string {
  return spans && text.includes('`')
    ? codeSpans(text).map(segment => segment.text).join('')
    : text
}

function runEnd(text: string, from: number): number {
  let end = from
  while (text.charCodeAt(end) === 96) {
    end++
  }
  return end
}

function closingRun(text: string, from: number, size: number): number {
  let index = text.indexOf('`', from)
  while (index !== -1) {
    const end = runEnd(text, index)
    if (end - index === size) {
      return index
    }
    index = text.indexOf('`', end)
  }
  return -1
}

function spanContent(raw: string): string {
  const text = raw.replace(/\r\n?|\n/g, ' ')
  return text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim()
    ? text.slice(1, -1)
    : text
}

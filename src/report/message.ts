export const DEFAULT_DISPLAY_MESSAGE_LENGTH = 1000

/** Split a message into the part shown by default and the remainder. */
export function clampMessage(message: string, max = DEFAULT_DISPLAY_MESSAGE_LENGTH): { head: string, rest: string } {
  return message.length <= max
    ? { head: message, rest: '' }
    : {
        head: message.slice(0, max),
        rest: message.slice(max),
      }
}

const BLANK_LINES_RE = /^(?:[^\S\n]*\n)+/

/** Split a message into its first line, which heads it, and the lines after it, without the blank lines between. */
export function splitHeadline(message: string): { headline: string, body: string } {
  const text = message.replace(BLANK_LINES_RE, '')
  const newline = text.indexOf('\n')
  return newline === -1
    ? { headline: text, body: '' }
    : {
        headline: text.slice(0, newline).trimEnd(),
        body: text.slice(newline + 1).replace(BLANK_LINES_RE, ''),
      }
}

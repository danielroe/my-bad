export const DEFAULT_DISPLAY_MESSAGE_LENGTH = 1000

/** Split a message into the part shown by default and the remainder. */
export function clampMessage(message: string, max = DEFAULT_DISPLAY_MESSAGE_LENGTH): { head: string, rest: string } {
  return message.length <= max ? { head: message, rest: '' } : { head: message.slice(0, max), rest: message.slice(max) }
}

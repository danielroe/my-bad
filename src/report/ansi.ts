/** OSC 8 payloads can contain commas, which `util.stripVTControlCharacters` mangles. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\]8;;[^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[0-9;:?]*[\u0020-\u002F]*[\u0040-\u007E]|\u001B[\u0040-\u005F]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

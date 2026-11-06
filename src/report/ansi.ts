/** The last alternative drops any control byte left over, so removing a sequence cannot join its neighbours into a new one. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B\[[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]|\u001B[\u0020-\u002F]*[\u0030-\u007E]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** Remove terminal escape sequences, and every C0 and C1 control other than `\t` and `\n`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

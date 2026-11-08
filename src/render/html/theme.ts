import type { Theme } from './state'

const CSS_VAR_RE = /^--[\w-]+$/

/** Theme overrides, with custom property names and values validated. */
export function themeStyles(theme: Theme | undefined, selector: string): string {
  const vars: string[] = []
  if (theme?.accent) {
    vars.push(`--mb-accent:${cssValue(theme.accent)}`)
  }
  for (const [name, value] of Object.entries(theme?.vars ?? {})) {
    if (CSS_VAR_RE.test(name)) {
      vars.push(`${name}:${cssValue(value)}`)
    }
  }
  return `${vars.length
    ? `${selector}{${vars.join(';')}}\n`
    : ''}${theme?.css ?? ''}`
}

function cssValue(value: string): string {
  return String(value).replace(/[;{}<]/g, '')
}

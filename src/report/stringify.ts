/** Render an arbitrary value as text, never throwing on circular or exotic input. */
export function stringifyValue(value: unknown, indent?: number): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, indent) ?? String(value)
  }
  catch {
    return String(value)
  }
}

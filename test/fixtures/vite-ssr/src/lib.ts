export function explode(reason: string): never {
  const error = new Error(`Render failed: ${reason}`)
  throw error
}

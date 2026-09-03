export function useBoom(label: string) {
  throw new Error(`boom from ${label}`)
}

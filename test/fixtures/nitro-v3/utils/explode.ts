export function explode(what: string): never {
  throw new Error(`Exploded while handling ${what}`)
}

export function detonate(what: string): never {
  return explode(what)
}

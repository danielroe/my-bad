export function buildWidget(name: string): string {
  if (!name) {
    throw new Error('Widget needs a name')
  }
  return name
}

export function loadWidget(name: string): string {
  return buildWidget(name)
}

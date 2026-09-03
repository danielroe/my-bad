import { explode } from './lib'

export interface Item {
  id: number
}

export function render(items: Item[]): string {
  const first = items[0]
  if (!first) {
    return explode('no items')
  }
  return `<p>${first.id}</p>`
}

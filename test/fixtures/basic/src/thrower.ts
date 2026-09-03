export class Widget {
  constructor(public name: string) {
    if (!name) {
      throw new TypeError('Widget needs a name')
    }
  }
}

export function makeWidget(name: string): Widget {
  return new Widget(name)
}

export async function loadWidget(name: string): Promise<Widget> {
  await Promise.resolve()
  return makeWidget(name)
}

export async function withCause(): Promise<never> {
  try {
    await loadWidget('')
  }
  catch (error) {
    throw new Error('Failed to load widget', { cause: error })
  }
  throw new Error('unreachable')
}

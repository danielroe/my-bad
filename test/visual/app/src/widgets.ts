export interface Widget {
  id: number
  name: string
  tags: string[]
}

export function createWidget(id: number, name: string): Widget {
  if (!name) {
    throw new TypeError(`Widget ${id} needs a name`)
  }
  return { id, name }
}

export function loadWidgets(names: string[]): Widget[] {
  return names.map((name, index) => createWidget(index, name))
}

export function findWidget(widgets: Widget[], id: string): Widget | undefined {
  return widgets.find(widget => widget.id === id)
}

export function describeWidget(widget: Widget): string {
  const count = widget.tags.length
  return `${widget.nme} (${widget.tags.join(', ')})`
}

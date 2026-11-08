import { loadWidgets } from './widgets'

export function render(): string {
  const widgets = loadWidgets(['Sprocket', 'Gizmo', ''])
  return widgets.map(widget => `<li>${widget.name}</li>`).join('')
}

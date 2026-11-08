import type { BadgeFocus } from '../state'

/** Sends a focus to an embedded docked view, again once it is ready, until it confirms. */
export function focusSender(frame: () => Window | null | undefined): (focus?: BadgeFocus) => void {
  let pending: BadgeFocus | undefined
  const deliver = () => {
    const target = frame()
    if (pending && target) {
      target.postMessage({ type: 'my-bad:select', ...pending }, location.origin)
    }
  }
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || !event.source || event.source !== frame()) {
      return
    }
    const type = (event.data as { type?: string } | undefined)?.type
    if (type === 'my-bad:ready') {
      deliver()
    }
    else if (type === 'my-bad:selected') {
      pending = undefined
    }
  })
  return (focus) => {
    if (focus) {
      pending = focus
    }
    deliver()
  }
}

import type { Frame } from '../types'

/** Original source contents that a loader found embedded in the map it used for a frame, with the file they belong to. */
const embedded = new WeakMap<Frame, { file: string | undefined, contents: string }>()

export function withEmbeddedSource(frame: Frame, contents: string | undefined): Frame {
  if (contents) {
    embedded.set(frame, { file: frame.file, contents })
  }
  return frame
}

/** Only while the frame still names the file the contents were recorded for, in case a later loader rewrote it in place. */
export function embeddedSource(frame: Frame): string | undefined {
  const entry = embedded.get(frame)
  return entry && entry.file === frame.file ? entry.contents : undefined
}

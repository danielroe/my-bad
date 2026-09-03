import type { Frame } from '../types'

/** Label a run of collapsed non-app frames, e.g. `3 dependency frames`. */
export function groupSummary(frames: Frame[]): string {
  const kinds = new Set(frames.map(frame => frame.type))
  const label = kinds.size > 1 ? 'dependency' : kinds.has('native') ? 'runtime' : kinds.has('internal') ? 'framework' : 'dependency'
  return `${frames.length} ${label} frame${frames.length === 1 ? '' : 's'}`
}

/**
 * Split frames into app frames and the runs of collapsed frames between them,
 * so each renderer only has to decide how to present a group.
 */
export function groupFrames(frames: Frame[]): Array<{ app: Frame, index: number } | { group: Array<{ frame: Frame, index: number }> }> {
  const out: Array<{ app: Frame, index: number } | { group: Array<{ frame: Frame, index: number }> }> = []
  let group: Array<{ frame: Frame, index: number }> = []
  for (const [index, frame] of frames.entries()) {
    if (frame.type === 'app') {
      if (group.length) {
        out.push({ group })
        group = []
      }
      out.push({ app: frame, index })
    }
    else {
      group.push({ frame, index })
    }
  }
  if (group.length) {
    out.push({ group })
  }
  return out
}

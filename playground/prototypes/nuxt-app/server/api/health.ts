import { faultEnabled, revision } from '../../shared/faults'

export default defineEventHandler(() => ({ ok: true, faultEnabled, revision }))

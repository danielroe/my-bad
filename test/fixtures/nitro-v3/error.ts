import { createReport, renderPage, serializeReport } from 'my-bad'
import { envPreset, nitroPreset } from 'my-bad/presets'
import { defineErrorHandler } from 'nitro'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { channel } from './utils/my-bad'

export default defineErrorHandler(async (error, event) => {
  const cwd = useRuntimeConfig().cwd as string
  const report = await createReport(error, {
    cwd,
    presets: [nitroPreset(), envPreset()],
    context: { event },
  })
  channel.setError(report)
  const accept = event.req.headers.get('accept') || ''
  if (accept.includes('application/json')) {
    return Response.json(serializeReport(report, { cwd }), { status: report.status ?? 500 })
  }
  return new Response(renderPage(report, { cwd, channel: '/__my-bad' }), {
    status: report.status ?? 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
})

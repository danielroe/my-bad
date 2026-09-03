import type { H3Error, H3Event } from 'h3'
import process from 'node:process'
import { getRequestHeader, send, setResponseHeader, setResponseStatus } from 'h3'
import { createReport, renderAnsi, renderPage } from 'my-bad'
import { nitroPreset } from 'my-bad/presets'

export default async function errorHandler(error: H3Error, event: H3Event): Promise<void> {
  const report = await createReport(error, {
    cwd: process.cwd(),
    presets: [nitroPreset()],
    context: { event },
  })

  console.error(renderAnsi(report, { cwd: process.cwd(), colors: false }))

  const status = error.statusCode || 500
  setResponseStatus(event, status, error.statusMessage)

  if (getRequestHeader(event, 'accept')?.includes('application/json')) {
    setResponseHeader(event, 'content-type', 'application/json')
    return send(event, JSON.stringify(report))
  }

  setResponseHeader(event, 'content-type', 'text/html')
  return send(event, renderPage(report, { cwd: process.cwd() }))
}

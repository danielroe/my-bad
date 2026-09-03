import { defineHandler } from 'nitro'
import { channel } from '../../utils/my-bad'

export default defineHandler(async event =>
  await channel.fetchHandler(event.req) ?? new Response('Not found', { status: 404 }),
)

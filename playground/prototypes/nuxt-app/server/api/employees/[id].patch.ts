import { saveEmployee } from '../../utils/employees'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (typeof body?.name !== 'string' || !body.name.trim() || typeof body?.email !== 'string' || !body.email.includes('@') || typeof body?.department !== 'string' || !body.department.trim())
    throw createError({ statusCode: 400, message: 'Name, email address, and department are required' })
  return saveEmployee(Number(getRouterParam(event, 'id')), { name: body.name.trim(), email: body.email.trim(), department: body.department.trim() }, getQuery(event).case === 'async')
})

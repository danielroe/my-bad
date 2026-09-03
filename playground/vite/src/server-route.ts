export function loadUser(id: string): { id: string, name: string } {
  const users: Record<string, { id: string, name: string }> = {}
  const user = users[id]
  if (!user) {
    throw new Error(`No user with id ${id}`)
  }
  return user
}

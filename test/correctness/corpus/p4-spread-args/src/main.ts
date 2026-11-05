declare function load(id: string, opts: { projection: { name: number; email: number } }): Promise<{ name: string } | undefined>
function isSolo(members: unknown[]): boolean {
  if (members.length === 1) return true
  return members.some((m) => typeof m === 'string')
}
// @vantle: "Q"
export async function q(id: string, other: string, users: string[]): Promise<boolean> {
  if (id === other) return isSolo([await load(id, { projection: { name: 1, email: 1 } }), ...users])
  return isSolo([await load(other, { projection: { name: 1, email: 1 } }), ...users])
}

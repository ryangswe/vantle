export interface User { admin: boolean; plan: string }

function isAdmin(u: { admin: boolean }): boolean {
  if (u.admin) return true
  return false
}

// @vantle: "Q"
export function check(u: User, b: boolean): string {
  if (!isAdmin(u)) return 'no'
  if (b) return 'b'
  if (isAdmin(u)) return 'admin'
  return 'never'
}

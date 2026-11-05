export interface User { admin: boolean }

// @vantle: "Q"
export function check(u: User, b: boolean): string {
  const a = u
  if (u.admin) {
    if (b) a.admin = false
    if (u.admin) return 'still'
    return 'revoked'
  }
  return 'user'
}

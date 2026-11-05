export interface User { admin: boolean; plan: string }

// @vantle: "Q"
export function check(u: User, b: boolean): string {
  if (u.admin) {
    if (b) return 'x'
  }
  if (u.admin) return 'admin'
  return 'user'
}

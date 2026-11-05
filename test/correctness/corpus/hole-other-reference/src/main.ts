export interface User { admin: boolean }
export interface Holder { user: User }

function demote(x: User) {
  x.admin = false
}

// @vantle: "Q"
export function check(u: User, holder: Holder, b: boolean): string {
  if (u.admin) {
    if (b) demote(holder.user)
    if (u.admin) return 'still'
    return 'revoked'
  }
  return 'user'
}

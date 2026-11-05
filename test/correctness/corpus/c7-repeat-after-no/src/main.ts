export interface User { banned: boolean; role: string }

// @vantle: "Q"
export function check(user: User, x: boolean): string {
  if (user.role === 'admin') return 'admin'
  if (x) {
    if (user.role === 'admin') return 'dead'
  }
  if (user.role === 'guest') return 'guest'
  return 'member'
}

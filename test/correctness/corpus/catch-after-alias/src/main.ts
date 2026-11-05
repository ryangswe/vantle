export interface User { admin: boolean }

// @vantle: "Q"
export function check(u: User, b: boolean, raw: string): string {
  const a = u
  let r = 'user'
  if (u.admin) {
    if (b) a.admin = false
    if (u.admin) r = 'still'
    else r = 'revoked'
  }
  try {
    JSON.parse(raw)
  } catch {}
  return r
}

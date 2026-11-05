function checkAlbum(ids: Set<string>, permission: string): string {
  if (ids.size === 0) return 'empty'
  if (permission === 'r') return 'read'
  return 'deny'
}

// @vantle: "Q"
export function check(permission: string, idSet: Set<string>): string {
  if (idSet.size === 0) return 'none'
  return checkAlbum(idSet, permission)
}

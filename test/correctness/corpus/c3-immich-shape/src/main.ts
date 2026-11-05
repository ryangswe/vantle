export interface Req { sharedLink: string | undefined; permission: string; ids: Set<string> }

function checkAlbum(request: Req): string {
  if (request.ids.size === 0) return 'empty'
  if (request.permission === 'r') return 'read'
  return 'deny'
}

// @vantle: "Q"
export function check(auth: { sharedLink: string | undefined }, permission: string, ids: string[]): string {
  const idSet = new Set(ids)
  if (idSet.size === 0) return 'none'
  return checkAlbum({ sharedLink: auth.sharedLink, permission, ids: idSet })
}

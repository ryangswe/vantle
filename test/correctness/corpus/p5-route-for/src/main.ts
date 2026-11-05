declare function mirror(path: string): string | undefined
declare function finish(kind: string, path: string, url: string): string
// @vantle: "Q"
export function routeFor(kind: string, selfHosted: boolean, zone: string, path: string = ''): string {
  if (path) {
    path = path.startsWith('/') ? path : '/' + path
  }
  if (kind === 'docs') return finish(kind, path, 'docs' + path)
  if (kind === 'status') return finish(kind, path, 'status' + path)
  if (kind === 'media') {
    const m = mirror(path)
    if (m) return finish(kind, path, m + path)
  }
  if (selfHosted) return finish(kind, path, 'local' + path)
  const host = 'example.net' + path
  switch (kind) {
    case 'media':
      return finish(kind, path, `https://media-${zone}.${host}`)
    case 'rest':
      return finish(kind, path, `https://${zone}.${host}`)
  }
  return ''
}

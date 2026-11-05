function prep(target: string, path: string): string {
  if (target === 'ui') return 'ui:' + path
  return path
}

// @vantle: "Q"
export function check(target: string, path: string, flags: boolean): string {
  if (target === 'ui') return prep(target, path)
  if (flags) return prep(target, path)
  return prep('assets', path)
}

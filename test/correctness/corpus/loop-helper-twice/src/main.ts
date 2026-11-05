function g(pre: boolean, items: string[]): string {
  if (pre) return 'early'
  for (const it of items) {
    if (it === 'x') return 'x'
  }
  return ''
}

// @vantle: "Q"
export function f(p: boolean, a: string[], b: boolean): string {
  if (g(p, a)) return 'got'
  return g(b, ['y'])
}

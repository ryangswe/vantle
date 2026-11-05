function h(p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): boolean {
  let mode = 'a'
  if (p) mode = 'b'
  if (a) return true
  if (b) return true
  if (c) return true
  if (d) return true
  return mode === m
}

// @vantle: "Q"
export function check(mode: string, p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): string {
  if (h(p, a, b, c, d, m)) return 'H'
  if (mode === 'a') return 'A'
  return 'other'
}

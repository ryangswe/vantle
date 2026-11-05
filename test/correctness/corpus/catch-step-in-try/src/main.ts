// @vantle: "Q"
export function check(q: boolean, p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, s: string): string {
  let mode = 'a'
  if (q) mode = 'c'
  if (a) return 'A'
  if (b) return 'B'
  try {
    if (p) mode = 'b'
    if (c) return 'C'
    if (d) return 'D'
    JSON.parse(s)
  } catch {
    return 'err'
  }
  if (mode === 'b') return 'modeB'
  return 'other'
}

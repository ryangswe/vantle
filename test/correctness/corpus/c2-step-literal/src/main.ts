// @vantle: "Q"
export function check(p: boolean, a: boolean, b: boolean, c: boolean, d: boolean): string {
  let mode = 'a'
  if (p) mode = 'b'
  if (a) return 'A'
  if (b) return 'B'
  if (c) return 'C'
  if (d) return 'D'
  if (mode === 'a') return 'modeA'
  return 'modeB'
}

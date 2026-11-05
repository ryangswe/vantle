interface O { x: number; p: boolean; q: boolean; r: boolean; s: boolean; y: number }
// @vantle: "Q"
export function f(a: boolean, b: boolean, flag: boolean, o: O): string {
  if (o.x === 1) return 'early'
  if (a) o.x = 1
  if (flag) {
    if (b) o.y = 1
    if (o.y === 5) return 'Y'
    if (o.p) return 'P'
    if (o.q) return 'Q'
    if (o.r) return 'R'
  }
  if (o.x === 1) return 'X'
  return 'Z'
}

// @vantle: "Q"
export function check(x: string | null, y: boolean): string {
  if (x === null) {
    if (y) return 'null-y'
  }
  if (!x) return 'empty'
  return 'set'
}

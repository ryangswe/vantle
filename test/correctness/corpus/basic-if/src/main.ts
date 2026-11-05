// @vantle: "Allowed?"
export function allowed(a: boolean, b: boolean, n: number): string {
  if (a) return 'a'
  if (b && n > 2) return 'b'
  if (n === 0) return 'zero'
  return 'none'
}

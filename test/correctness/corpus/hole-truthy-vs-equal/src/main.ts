// @vantle: "Q"
export function check(x: string | null, y: boolean): string {
  if (x === 'a') {
    if (y) return 'ya'
  }
  if (x) return 'set'
  return 'unset'
}

export interface Flag { a: boolean }

// @vantle: "Q"
export function check(x: Flag, items: string[]): string {
  if (x.a) return 'pre'
  for (const it of items) {
    if (x.a) return 'second-pass'
    if (it === 'go') x.a = true
  }
  return 'end'
}

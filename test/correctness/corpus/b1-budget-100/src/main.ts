function deep(n: number): boolean { if (n > 9) throw new Error('big'); if (n > 5) return true; if (n > 3) return true; return n > 1 }
function mid(n: number): boolean { if (n < 0) return false; if (n === 7) return true; return deep(n) }
function top(n: number): boolean { if (n === 100) return true; if (n === 50) return false; return mid(n) }
// @vantle: "Q"
export function entry(a: number, b: number): string {
  if (top(a)) return 'A'
  if (top(b)) return 'B'
  return 'C'
}

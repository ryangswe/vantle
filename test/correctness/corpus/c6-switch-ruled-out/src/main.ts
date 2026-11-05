export type Op = 'a' | 'b' | 'c'

function h(op: Op): string {
  switch (op) {
    case 'a': return 'A'
    case 'b': return 'B'
    default: return 'other'
  }
}

// @vantle: "Q"
export function check(op: Op): string {
  if (op === 'c') return 'C'
  return h(op)
}

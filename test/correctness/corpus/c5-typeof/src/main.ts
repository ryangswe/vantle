function name(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return 'num'
  return 'other'
}

// @vantle: "Q"
export function check(v: unknown): string {
  if (typeof v === 'string') return name(v)
  if (typeof v === 'number') return 'n'
  return name(v)
}

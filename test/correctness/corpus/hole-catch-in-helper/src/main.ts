function load(s: string): unknown {
  if (!s) throw new Error('missing')
  return JSON.parse(s)
}

// @vantle: "Q"
export function check(s: string): string {
  try {
    load(s)
    return 'ok'
  } catch {
    if (s) return 'bad json'
    return 'missing'
  }
}

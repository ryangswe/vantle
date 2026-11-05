function parse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch (e) {
    if (s.length > 3) throw e
    return null
  }
}

// @vantle: "Q"
export function check(s: string): string {
  try {
    parse(s)
    return 'ok'
  } catch {
    if (s.length > 5) return 'long bad'
    return 'bad'
  }
}

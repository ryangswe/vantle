import { createHash } from 'node:crypto'

export function shortHash(text: string, length = 6): string {
  return createHash('sha1').update(text).digest('hex').slice(0, length)
}

export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/** Collapses whitespace and strips parentheses that wrap the whole expression. */
export function normalizeCode(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim()
  while (out.startsWith('(') && out.endsWith(')') && wrapsWhole(out)) {
    out = out.slice(1, -1).trim()
  }
  return out
}

function wrapsWhole(text: string): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    if (depth === 0 && i < text.length - 1) return false
  }
  return true
}

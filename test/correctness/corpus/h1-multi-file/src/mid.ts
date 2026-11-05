import { deep } from './deep'
export function mid(n: number): boolean { if (n < 0) return false; if (n === 7) return true; return deep(n) }

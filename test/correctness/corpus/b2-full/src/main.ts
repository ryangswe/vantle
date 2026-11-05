function C(n: number): boolean { if (n === 31) return true; if (n === 32) return true; if (n === 33) return true; return n === 34 }
function B(n: number): boolean { if (n === 21) return true; if (n === 22) return true; return C(n) }
function A(n: number): boolean { if (n === 11) return true; return B(n) }
function K(n: number): boolean { if (n === 61) return true; if (n === 62) return true; if (n === 63) return true; if (n === 64) return true; if (n === 65) return true; if (n === 66) return true; if (n === 67) return true; return n === 68 }
function H(n: number): boolean { if (n === 51) return true; if (n === 52) return true; if (n === 53) return true; if (n === 54) return true; return K(n) }
// @vantle: "Q"
export function entry(a: number, z: boolean): string {
  if (z) return 'Z'
  if (A(a)) return 'A'
  if (H(a)) return 'H'
  return 'C'
}

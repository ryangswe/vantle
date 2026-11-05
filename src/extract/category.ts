import type { CallRef, Category } from '../schema/flow.js'

const PREF = /pref|setting|config|flag|option|toggle|mute/i
const STATE = /store|state|presence|dnd|session|cache|db|repo|subscri|status|push|inventory|account/i

/**
 * A first guess at where a decision's data comes from, based on what it calls
 * and how things are named. The labeling step confirms or corrects it.
 */
export function categorize(rawLabel: string, calls: CallRef[]): Category {
  const signals = [rawLabel, ...calls.map((c) => `${c.file ?? ''} ${c.callee}`)].join(' ')
  if (PREF.test(signals)) return 'pref'
  if (STATE.test(signals)) return 'state'
  if (calls.some((c) => c.external)) return 'external'
  return 'input'
}

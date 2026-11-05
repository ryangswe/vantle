const lastActiveAt = new Map<string, number>()
const PUSH_DELAY_MS = 30_000

export const push = {
  /** Mobile pushes wait until the user has been idle on desktop for a while. */
  isPastTimingThreshold(userId: string, messageTs: string): boolean {
    return Number(messageTs) * 1000 - (lastActiveAt.get(userId) ?? 0) > PUSH_DELAY_MS
  },
}

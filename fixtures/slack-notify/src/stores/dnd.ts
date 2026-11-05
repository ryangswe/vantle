const snoozedUntil = new Map<string, number>()

export const dnd = {
  isActive(userId: string): boolean {
    return (snoozedUntil.get(userId) ?? 0) > Date.now()
  },
}

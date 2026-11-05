const active = new Set<string>()

export const presence = {
  isActive(userId: string): boolean {
    return active.has(userId)
  },
}

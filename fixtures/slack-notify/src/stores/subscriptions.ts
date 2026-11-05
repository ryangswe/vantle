const subscribed = new Set<string>()

export const subscriptions = {
  isSubscribed(userId: string, threadTs: string | undefined): boolean {
    return subscribed.has(`${userId}:${threadTs}`)
  },
}

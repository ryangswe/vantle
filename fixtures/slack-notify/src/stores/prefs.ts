import type { ChannelPref, Device, GlobalPref } from '../types'

// In-memory stand-in for the preferences service.
const store = {
  muted: new Set<string>(),
  suppressBroadcast: new Set<string>(),
  threadsEverything: new Set<string>(),
  channel: new Map<string, ChannelPref>(),
  global: new Map<string, GlobalPref>(),
}

export const prefs = {
  isChannelMuted(userId: string, channelId: string): boolean {
    return store.muted.has(`${userId}:${channelId}`)
  },
  suppressesBroadcastMentions(userId: string, channelId: string): boolean {
    return store.suppressBroadcast.has(`${userId}:${channelId}`)
  },
  threadsEverything(userId: string): boolean {
    return store.threadsEverything.has(userId)
  },
  channelPref(userId: string, channelId: string, device: Device): ChannelPref {
    return store.channel.get(`${userId}:${channelId}:${device}`) ?? 'default'
  },
  globalPref(userId: string, device: Device): GlobalPref {
    return store.global.get(`${userId}:${device}`) ?? 'all'
  },
}

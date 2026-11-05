// A TypeScript version of Slack's "Should we send a notification?" flowchart.
// It's the reference test case for Vantle: the correct chart is in ../expected.json.

import { channelPrefAllows } from './modes'
import { isBroadcastMention, isThreadMessage } from './parse'
import { dnd } from './stores/dnd'
import { prefs } from './stores/prefs'
import { push } from './stores/push'
import { subscriptions } from './stores/subscriptions'
import type { Channel, Device, Message, User } from './types'

// @vantle: "Should we send a notification?"
export function shouldNotify(msg: Message, user: User, channel: Channel, device: Device): boolean {
  if (!wantsNotification(msg, user, channel, device)) return false
  return deliverNow(msg, user, device)
}

function wantsNotification(msg: Message, user: User, channel: Channel, device: Device): boolean {
  // Muted channels only notify for threads the user follows.
  if (prefs.isChannelMuted(user.id, channel.id)) {
    if (!isSubscribedThread(msg, user)) return false
  }

  if (dnd.isActive(user.id)) {
    if (!msg.dndOverride) return false
  }

  if (isBroadcastMention(msg)) {
    if (prefs.suppressesBroadcastMentions(user.id, channel.id)) return false
  }

  if (isSubscribedThread(msg, user)) {
    if (prefs.threadsEverything(user.id)) {
      return prefs.channelPref(user.id, channel.id, device) !== 'nothing'
    }
  }

  return channelPrefAllows(msg, user, channel, device)
}

function isSubscribedThread(msg: Message, user: User): boolean {
  return isThreadMessage(msg) && subscriptions.isSubscribed(user.id, msg.threadTs)
}

function deliverNow(msg: Message, user: User, device: Device): boolean {
  if (device === 'mobile') {
    return push.isPastTimingThreshold(user.id, msg.ts)
  }
  return true
}

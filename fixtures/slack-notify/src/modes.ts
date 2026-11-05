// The channel and global notification-preference branches of the Slack chart.
//
// Where the original chart is ambiguous, this file picks one reading:
// - The "Mentions" fan-out (DM, @mention, @here, highlight word) is checked in
//   that order. An @here with the user away falls through to the highlight check.
// - A DM in "Mentions" mode goes through the simple thread check (not thread → yes,
//   subscribed → yes, otherwise no) instead of looping back to "Mentions".
// Parameter names differ from notify.ts on purpose, so the extractor has to
// map them back to the caller's arguments.

import { hasHighlightWord, isCommentOnOwnedFile, isDirectMessage, isHereMention, isThreadMessage, mentionsUser } from './parse'
import { prefs } from './stores/prefs'
import { presence } from './stores/presence'
import { subscriptions } from './stores/subscriptions'
import type { Channel, Device, Message, User } from './types'

export function channelPrefAllows(m: Message, u: User, ch: Channel, dev: Device): boolean {
  switch (prefs.channelPref(u.id, ch.id, dev)) {
    case 'nothing':
      return false
    case 'everything':
      if (!isThreadMessage(m)) return true
      if (subscriptions.isSubscribed(u.id, m.threadTs)) return true
      return channelMentionsAllow(m, u, dev)
    case 'mentions':
      return channelMentionsAllow(m, u, dev)
    case 'default':
      return globalPrefAllows(m, u, dev)
  }
}

function globalPrefAllows(m: Message, u: User, dev: Device): boolean {
  switch (prefs.globalPref(u.id, dev)) {
    case 'all':
      if (!isThreadMessage(m)) return true
      if (subscriptions.isSubscribed(u.id, m.threadTs)) return true
      return mentionChecks(m, u, dev)
    case 'mentions':
      return mentionChecks(m, u, dev)
    case 'dms':
      if (isDirectMessage(m)) return threadGate(m, u)
      return false
    case 'highlight_words':
      if (mentionsUser(m, u) || hasHighlightWord(m, u)) return threadGate(m, u)
      return false
    case 'never':
      return false
  }
}

function channelMentionsAllow(m: Message, u: User, dev: Device): boolean {
  if (isDirectMessage(m)) return threadGate(m, u)
  return mentionChecks(m, u, dev)
}

function mentionChecks(msg: Message, user: User, device: Device): boolean {
  if (mentionsUser(msg, user) || (device === 'desktop' && isCommentOnOwnedFile(msg, user))) return true
  if (isHereMention(msg)) {
    if (presence.isActive(user.id)) return threadGate(msg, user)
  }
  if (hasHighlightWord(msg, user)) return threadGate(msg, user)
  return false
}

function threadGate(msg: Message, user: User): boolean {
  if (!isThreadMessage(msg)) return true
  return subscriptions.isSubscribed(user.id, msg.threadTs)
}

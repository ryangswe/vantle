import type { Message, User } from './types'

export function isThreadMessage(msg: Message): boolean {
  return msg.threadTs !== undefined
}

export function isBroadcastMention(msg: Message): boolean {
  return /<!(channel|everyone|here)>/.test(msg.text)
}

export function isHereMention(msg: Message): boolean {
  return msg.text.includes('<!here>')
}

export function isDirectMessage(msg: Message): boolean {
  return msg.isDM
}

export function mentionsUser(msg: Message, user: User): boolean {
  return msg.text.includes(`<@${user.id}>`)
}

export function isCommentOnOwnedFile(msg: Message, user: User): boolean {
  return msg.isFileComment && msg.fileOwnerId === user.id
}

export function hasHighlightWord(msg: Message, user: User): boolean {
  const text = msg.text.toLowerCase()
  return user.highlightWords.some((word) => text.includes(word.toLowerCase()))
}

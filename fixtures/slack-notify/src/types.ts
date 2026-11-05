export type Device = 'desktop' | 'mobile'
export type ChannelPref = 'nothing' | 'everything' | 'mentions' | 'default'
export type GlobalPref = 'all' | 'mentions' | 'dms' | 'highlight_words' | 'never'

export interface User {
  id: string
  highlightWords: string[]
}

export interface Channel {
  id: string
}

export interface Message {
  ts: string
  text: string
  isDM: boolean
  threadTs?: string
  /** Sender chose "notify anyway" while the recipient is in Do Not Disturb. */
  dndOverride: boolean
  isFileComment: boolean
  fileOwnerId?: string
}

export interface Room { t: string }

function getRoom(room: Room | null, errorOnEmpty = true): string {
  if (!room && errorOnEmpty) throw new Error('empty')
  if (!room) return 'null'
  return 'room'
}

// @vantle: "Q"
export function check(room: Room | null): string {
  return getRoom(room)
}

export interface Room { t: string }
export interface Opts { errorOnEmpty?: boolean; type?: string }

function getRoom({ errorOnEmpty = true, type }: Opts = {}, room: Room | null): string {
  if (type && room && room.t !== type) return 'wrongType'
  if (!room && errorOnEmpty) throw new Error('empty')
  if (!room) return 'null'
  return 'room'
}

// @vantle: "Q"
export function check(room: Room | null): string {
  return getRoom({}, room)
}

interface Item { w?: number; x?: number; y?: number; z?: number; u?: number; v?: number; s?: number; t?: number; id: string; live: boolean; shelf: string; dirty(): boolean; refresh(): Promise<void> }
declare function reserve(id: string): Promise<unknown>
declare function locate(body: string, anchor: string): number
function rewrite(item: Item, body: string, style = 'swap', anchor?: string): Item {
  if (style === 'splice') {
    if (!anchor) throw new Error('anchor needed')
    if (locate(body, anchor) === -1) throw new Error('anchor missing')
    return item
  }
  if (style === 'extend') item.w = 1
  return item
}
// @vantle: "Q"
export async function edit(item: Item, w?: number, x?: number, y?: number, z?: number, u?: number, v?: number, s?: number, t?: number, body?: string, style?: string, anchor?: string, guarded?: boolean, version?: number, note?: string, release?: boolean): Promise<string> {
  const shelf = item.shelf
  if (w !== undefined) item.w = w
  if (x) item.x = x
  if (y !== undefined) item.y = y
  if (z) item.z = z
  if (u !== undefined) item.u = u
  if (v) item.v = v
  if (s !== undefined) item.s = s
  if (t) item.t = t
  if (body !== undefined) item = rewrite(item, body, style, anchor)
  if (guarded) {
    const held = await reserve(item.id)
    if (!held && version !== undefined) throw new Error('stale version')
  }
  if (note !== undefined) {
    await item.refresh()
    if (item.live) throw new Error('still live')
    return 'noted'
  }
  const dirty = item.dirty()
  if (release) return 'released'
  else if (dirty) return 'stored'
  if (release || item.shelf !== shelf) return 'moved'
  return 'unchanged'
}

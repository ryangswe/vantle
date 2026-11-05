export interface Store { isOn(id: string): boolean; plan(): Promise<string> }
// @vantle: "Q"
export async function q(store: Store, id: string): Promise<string> {
  if (!store.isOn(id)) return 'off'
  const plan = await store.plan()
  if (plan === 'pro') return 'pro'
  if (store.isOn(id)) return 'still on'
  throw new Error('impossible')
}

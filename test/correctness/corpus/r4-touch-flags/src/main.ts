interface W { hits: number; a: number; b: number; ok: boolean; ready: boolean; done: boolean; live: boolean }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
function touch(w: W, p: boolean, q: boolean): boolean {
  if (p) w.a = 1
  if (q) w.b = 2
  if (w.ok) return true
  if (w.ready) return true
  if (w.done) return true
  if (w.live) return true
  return false
}
// @vantle: "Q"
export function entry(p: boolean, q: boolean, x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (touch(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'), p, q)) return 'A'
  if (touch(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'), p, q)) return 'B'
  return 'C'
}

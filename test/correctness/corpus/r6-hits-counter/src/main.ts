interface W { hits: number; ready: boolean }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
function touch(w: W): boolean {
  w.hits = w.hits + 1
  if (w.ready) return true
  if (w.hits > 3) return true
  return false
}
// @vantle: "Q"
export function entry(x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (touch(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'))) return 'A'
  if (touch(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'))) return 'B'
  return 'C'
}

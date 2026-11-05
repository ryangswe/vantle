interface W { short: boolean; code: string; name: string; hits: number; ready: boolean }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
function label(w: W): string { if (w.short) return w.code; return w.name }
function touch(w: W): boolean { w.hits = 1; if (w.ready) return true; return false }
// @vantle: "Q"
export function entry(pickFirst: boolean, x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (touch(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'))) return 'A'
  if (touch(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'))) return 'B'
  if (pickFirst) return label(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'))
  return label(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'))
}

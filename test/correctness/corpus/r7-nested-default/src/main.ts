interface C { on: boolean }
interface W { cfg: C; kind: string; off: boolean }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
function inner(c: C): boolean { if (c.on) return true; return false }
function outer(w: W): boolean { if (w.off) return false; return inner(w.cfg) }
function kindOf(w: W, k = w.kind): boolean { if (k === 'big') return true; return false }
// @vantle: "Q"
export function entry(x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (outer(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'))) return 'A'
  if (outer(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'))) return 'B'
  if (kindOf(x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu'))) return 'C'
  if (kindOf(y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu'))) return 'D'
  return 'E'
}

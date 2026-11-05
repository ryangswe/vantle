class Widget { enabled = false; legacy = false
  isOn(): boolean { if (this.enabled) return true; return this.legacy }
}
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): Widget }
// @vantle: "Q"
export function entry(x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu').isOn()) return 'a'
  if (y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu').isOn()) return 'b'
  return 'c'
}
export { Widget }

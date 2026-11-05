class Widget { short = false; code = ''; name = ''
  label(): string { if (this.short) return this.code; return this.name }
}
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): Widget }
// @vantle: "Q"
export function entry(pickFirst: boolean, x: { registry: Reg; tenantIdentifier: string }, y: { registry: Reg; tenantIdentifier: string }): string {
  if (pickFirst) return x.registry.lookupPrimaryWidgetForTenantWithFallback(x.tenantIdentifier, 'eu').label()
  return y.registry.lookupPrimaryWidgetForTenantWithFallback(y.tenantIdentifier, 'eu').label()
}
export { Widget }

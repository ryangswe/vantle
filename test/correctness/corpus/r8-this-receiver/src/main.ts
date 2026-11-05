class Widget { enabled = false; isOn(): boolean { if (this.enabled) return true; return false } }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): Widget }
export class Svc {
  enabled = true
  registry!: Reg
  // @vantle: "Q"
  decide(tenantIdentifier: string): string {
    if (this.enabled) return 'self-on'
    if (this.registry.lookupPrimaryWidgetForTenantWithFallback(tenantIdentifier, 'eu').isOn()) return 'widget-on'
    return 'off'
  }
}
export { Widget }

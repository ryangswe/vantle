class Widget { short = false; code = ''; name = ''
  label(): string { if (this.short) return this.code; return this.name } }
interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): Widget }
interface Ctx { registry: Reg; tenantIdentifier: string; off: boolean }
function outer(p: Ctx): string {
  if (p.off) return 'off'
  return p.registry.lookupPrimaryWidgetForTenantWithFallback(p.tenantIdentifier, 'eu').label()
}
// @vantle: "Q"
export function entry(k: boolean, x: { primaryContextForTheCurrentRequestThatIsVeryLongIndeedOkayYes: Ctx; secondaryContextForTheCurrentRequestThatIsVeryLongIndeedOkayYes: Ctx }): string {
  if (k) return outer(x.primaryContextForTheCurrentRequestThatIsVeryLongIndeedOkayYes)
  return outer(x.secondaryContextForTheCurrentRequestThatIsVeryLongIndeedOkayYes)
}
export { Widget }

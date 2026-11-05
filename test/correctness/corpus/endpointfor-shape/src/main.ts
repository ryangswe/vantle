export interface Config { rewriteRequestPath: boolean }
export type Target = 'ui' | 'flags' | 'assets' | 'api'

export class Router {
  constructor(public config: Config, public region: string, public override: boolean) {}

  prepare(target: Target, path: string): string {
    if (target === 'ui') return 'ui:' + path
    if (this.config.rewriteRequestPath) return 'rewritten:' + path
    return path
  }

  // @vantle: "Q"
  endpointFor(target: Target, path: string): string {
    if (target === 'ui') return this.prepare(target, path)
    if (target === 'flags') return this.prepare(target, '/flags' + path)
    if (target === 'assets' && this.override) return this.prepare(target, '/static' + path)
    if (this.region === 'custom') return this.prepare(target, '/custom' + path)
    switch (target) {
      case 'assets': return this.prepare(target, '/assets' + path)
      case 'api': return this.prepare(target, '/api' + path)
    }
  }
}

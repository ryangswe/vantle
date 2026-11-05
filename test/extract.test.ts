import { describe, expect, it } from 'vitest'
import { compareBehavior, enumeratePaths, toGraph, type Graph } from '../src/graph/paths.js'
import { hasConflict } from '../src/verify/select.js'
import type { RawFlow } from '../src/schema/flow.js'
import { extract, tempProject } from './helpers.js'

const decisions = (flow: RawFlow) => flow.nodes.filter((n) => n.kind === 'decision').map((n) => n.rawLabel)
const outcomes = (flow: RawFlow) => flow.nodes.filter((n) => n.kind === 'outcome').map((n) => n.rawLabel).sort()
const edgesFrom = (flow: RawFlow, label: string) => {
  const node = flow.nodes.find((n) => n.rawLabel === label)
  return flow.edges.filter((e) => e.from === node?.id).map((e) => e.label)
}

function one(source: string) {
  return extract(tempProject({ 'main.ts': source }))
}

describe('extractor', () => {
  it('follows if / else if / else chains', () => {
    const flow = one(`
      // @vantle: "Allowed?"
      export function allowed(a: boolean, b: boolean): boolean {
        if (a) return true
        else if (b) return false
        else return true
      }`)
    expect(decisions(flow)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(flow.pathCount).toBe(3)
  })

  it('swaps branches for negated conditions instead of drawing a "not" box', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(user: { banned: boolean }): boolean {
        if (!user.banned) return true
        return false
      }`)
    expect(decisions(flow)).toEqual(['user.banned'])
    const banned = flow.nodes.find((n) => n.rawLabel === 'user.banned')!
    const yes = flow.edges.find((e) => e.from === banned.id && e.label === 'yes')!
    expect(flow.nodes.find((n) => n.id === yes.to)?.rawLabel).toBe('false')
  })

  it('turns ternaries into decisions', () => {
    const flow = one(`
      // @vantle: "Tier"
      export function tier(score: number): string {
        return score > 90 ? 'gold' : score > 50 ? 'silver' : 'none'
      }`)
    expect(decisions(flow)).toEqual(expect.arrayContaining(['score > 90', 'score > 50']))
    expect(outcomes(flow)).toEqual(["'gold'", "'none'", "'silver'"])
  })

  it('handles switch fallthrough, break and default', () => {
    const flow = one(`
      // @vantle: "Fee"
      export function fee(plan: string, intl: boolean): number {
        switch (plan) {
          case 'free':
          case 'trial':
            return 0
          case 'pro':
            if (intl) return 5
            break
          default:
            return 10
        }
        return 3
      }`)
    expect(edgesFrom(flow, 'plan').sort()).toEqual(["'free'", "'pro'", "'trial'", 'default'])
    expect(outcomes(flow)).toEqual(['0', '10', '3', '5'])
    // 'free' falls through to 'trial', so both lead to the same place.
    const plan = flow.nodes.find((n) => n.rawLabel === 'plan')!
    const to = (label: string) => flow.edges.find((e) => e.from === plan.id && e.label === label)?.to
    expect(to("'free'")).toBe(to("'trial'"))
  })

  it('adds an "other" branch only when a switch is not exhaustive', () => {
    const flow = one(`
      type Mode = 'a' | 'b'
      // @vantle: "Q"
      export function q(mode: Mode, name: string): boolean {
        switch (mode) {
          case 'a': return true
          case 'b': break
        }
        switch (name) {
          case 'x': return true
        }
        return false
      }`)
    expect(edgesFrom(flow, 'mode').sort()).toEqual(["'a'", "'b'"])
    expect(edgesFrom(flow, 'name').sort()).toEqual(["'x'", 'other'])
  })

  it('inlines helpers that branch, and keeps simple ones as one box', () => {
    const flow = one(`
      function isAdmin(u: { role: string }): boolean { return u.role === 'admin' }
      function canEdit(person: { role: string; locked: boolean }): boolean {
        if (person.locked) return false
        return isAdmin(person)
      }
      // @vantle: "Can edit?"
      export function check(user: { role: string; locked: boolean }): boolean {
        return canEdit(user)
      }`)
    expect(decisions(flow).sort()).toEqual(['isAdmin(user)', 'user.locked'])
  })

  it('inlines a helper whose branches come after a callback', () => {
    const flow = one(`
      function allowed(tags: string[], blocked: boolean): boolean {
        const names = tags.map((t) => t.toLowerCase())
        if (blocked) return false
        return names.length > 0
      }
      // @vantle: "Allowed?"
      export function check(tags: string[], blocked: boolean): boolean {
        return allowed(tags, blocked)
      }`)
    expect(decisions(flow)).toContain('blocked')
  })

  it('folds local constants into conditions', () => {
    const flow = one(`
      declare function loadPlan(id: string): { seats: number }
      // @vantle: "Q"
      export function q(id: string): boolean {
        const plan = loadPlan(id)
        const seats = plan.seats
        if (seats > 10) return true
        return false
      }`)
    expect(decisions(flow)).toEqual(['loadPlan(id).seats > 10'])
  })

  it('reuses one subgraph for a helper called twice with the same arguments', () => {
    const flow = one(`
      function gate(x: { a: boolean; b: boolean }): boolean {
        if (x.a) return true
        return x.b
      }
      // @vantle: "Q"
      export function q(input: { a: boolean; b: boolean; c: boolean }): boolean {
        if (input.c) return gate(input)
        return gate(input)
      }`)
    // With the same destinations, both calls share the same two boxes (and the
    // c check collapses because both branches go to the same place).
    expect(decisions(flow).sort()).toEqual(['input.a', 'input.b'])
  })

  it('stops at recursion and at the depth limit, with a warning', () => {
    const recursive = one(`
      // @vantle: "Q"
      export function q(n: number): boolean {
        if (n <= 0) return true
        return q(n - 1)
      }`)
    expect(decisions(recursive)).toEqual(expect.arrayContaining(['n <= 0', 'q(n - 1)']))
    expect(recursive.warnings.join(' ')).toMatch(/calls itself/)

    const deep = extract(
      tempProject({
        'main.ts': `
          function c(x: boolean): boolean { if (x) return true; return false }
          function b(x: boolean): boolean { if (x) return c(x); return false }
          // @vantle: "Q"
          export function a(x: boolean, y: boolean): boolean { if (y) return b(x); return false }`,
      }),
      undefined,
      { depth: 1 },
    )
    expect(decisions(deep)).toContain('c(x)')
    expect(deep.warnings.join(' ')).toMatch(/depth 1/)
  })

  it('keeps recursive helpers, like rule engines, as one box', () => {
    const flow = one(`
      type Rule = { all?: Rule[]; is?: string }
      function matches(rule: Rule, value: string): boolean {
        if (rule.all) return rule.all.every((r) => matches(r, value))
        if (rule.is !== undefined) return rule.is === value
        return true
      }
      // @vantle: "Q"
      export function q(rule: Rule, value: string, on: boolean): boolean {
        if (!on) return false
        return matches(rule, value)
      }`)
    expect(decisions(flow).sort()).toEqual(['matches(rule, value)', 'on'])
    expect(flow.warnings.join(' ')).toMatch(/matches is recursive/)
  })

  it('keeps a helper as one box when following it would add too many boxes', () => {
    const source = `
      function engine(x: number): boolean {
        if (x === 1) return true
        if (x === 2) return false
        if (x === 3) return true
        return false
      }
      // @vantle: "Q"
      export function q(x: number, on: boolean): boolean {
        if (!on) return false
        return engine(x)
      }`
    const dir = tempProject({ 'main.ts': source })
    expect(decisions(extract(dir)).sort()).toEqual(['on', 'x === 1', 'x === 2', 'x === 3'])
    const capped = extract(dir, undefined, { maxInline: 2 })
    expect(decisions(capped).sort()).toEqual(['engine(x)', 'on'])
    expect(capped.warnings.join(' ')).toMatch(/engine is shown as one box: following it would add 3 boxes/)
  })

  it('follows a loop body as one pass, so early returns inside it show up', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(items: number[], strict: boolean): boolean {
        for (const i of items) {
          if (i < 0) continue
          if (i > 3) return true
        }
        if (strict) return false
        return true
      }`)
    const inLoop = flow.nodes.filter((n) => n.kind === 'decision' && n.loop)
    expect(inLoop.map((n) => n.rawLabel).sort()).toEqual(['i < 0', 'i > 3'])
    expect(inLoop[0]).toMatchObject({ loop: 'for (const i of items)' })
    expect(decisions(flow)).toContain('strict')
    expect(flow.nodes.some((n) => n.kind === 'opaque')).toBe(false)
    expect(flow.warnings.join(' ')).toMatch(/one pass/)
  })

  it('works for arrow functions and methods', () => {
    const arrow = one(`
      // @vantle: "Q"
      export const q = (n: number): boolean => n > 2`)
    expect(decisions(arrow)).toEqual(['n > 2'])

    const method = one(`
      export class Policy {
        // @vantle: "Allowed?"
        allowed(n: number): boolean {
          if (n > 2) return true
          return false
        }
      }`)
    expect(method.flow.id).toBe('src/main.ts#Policy.allowed')
    expect(decisions(method)).toEqual(['n > 2'])
  })

  it('treats throw as an outcome', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(n: number): number {
        if (n < 0) throw new Error('negative')
        return n
      }`)
    expect(outcomes(flow)).toEqual(['n', "throw new Error('negative')"])
  })
})

describe('variable tracking', () => {
  it('follows a flag set in one branch and tested later', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): boolean {
        let blocked = false
        if (a) blocked = true
        if (blocked) return false
        return b
      }`)
    // \`blocked\` disappears: when a is yes it's known to be true, otherwise false.
    expect(decisions(flow).sort()).toEqual(['a', 'b'])
    const a = flow.nodes.find((n) => n.rawLabel === 'a')!
    const yes = flow.edges.find((e) => e.from === a.id && e.label === 'yes')!
    expect(flow.nodes.find((n) => n.id === yes.to)?.rawLabel).toBe('false')
  })

  it('rewrites later checks with the value a branch assigned', () => {
    const flow = one(`
      declare function lookup(id: string): number
      // @vantle: "Q"
      export function q(sticky: boolean, id: string): string {
        let assigned = -1
        if (sticky) assigned = lookup(id)
        if (assigned < 0) return 'none'
        return 'some'
      }`)
    expect(decisions(flow).sort()).toEqual(['lookup(id) < 0', 'sticky'])
  })

  it('folds destructured constants', () => {
    const flow = one(`
      declare function getHash(user: string): { hashValue: string; attr: string }
      // @vantle: "Q"
      export function q(user: string): boolean {
        const { hashValue, attr: name } = getHash(user)
        if (!hashValue) return false
        return name === 'id'
      }`)
    expect(decisions(flow).sort()).toEqual(["getHash(user).attr === 'id'", 'getHash(user).hashValue'])
  })

  it("doesn't split the chart on variables that are never read again", () => {
    const flow = one(`
      declare function log(text: string): void
      // @vantle: "Q"
      export function q(a: boolean, b: boolean, c: boolean): boolean {
        let note = ''
        if (a) note = 'x'
        log(note)
        if (b) return true
        if (c) return true
        return false
      }`)
    // a only changes what gets logged, so it isn't a decision, and b and c appear once.
    expect(decisions(flow).sort()).toEqual(['b', 'c'])
  })

  it('treats variables changed inside a loop as unknown after it', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(xs: number[]): boolean {
        let found = false
        for (const x of xs) {
          if (x > 3) found = true
        }
        if (found) return true
        return false
      }`)
    expect(decisions(flow)).toEqual(['found'])
  })

  it('stops tracking values when there are too many combinations', () => {
    const flags = Array.from({ length: 7 }, (_, i) => i + 1)
    const flow = one(`
      // @vantle: "Q"
      export function q(${flags.map((i) => `a${i}: boolean`).join(', ')}): boolean {
        ${flags.map((i) => `let f${i} = 0`).join('\n        ')}
        ${flags.map((i) => `if (a${i}) f${i} = 1`).join('\n        ')}
        return ${flags.map((i) => `f${i}`).join(' + ')} > 3
      }`)
    expect(flow.warnings.join(' ')).toMatch(/Too many combinations|drawn once for every branch/)
    expect(flow.nodes.filter((n) => n.kind === 'decision').length).toBeLessThan(200)
    // Every check still shows on every path: none is dropped as "both sides end the same way".
    const labels = new Set(flow.nodes.flatMap((n) => (n.kind === 'decision' ? [n.rawLabel] : [])))
    for (const i of flags) expect(labels.has(`a${i}`)).toBe(true)
    expect(flow.notCharted ?? []).toEqual([])
  })

  it('draws the checks of a helper called as a statement when it can throw', () => {
    // Novu, Vendure, Directus, Documenso: guards like \`assertNotBanned(u)\` were
    // neither drawn nor listed, so the chart missed every way the function rejects input.
    const dir = tempProject({
      'guard.ts': `export class Guard { static check(u: { name: string }) { if (u.name.length > 10) throw new Error('long') } }`,
      'main.ts': `
        import { Guard } from './guard'
        type U = { admin: boolean; banned: boolean; email?: string; name: string }
        function assertNotBanned(u: U) {
          if (u.banned) throw new Error('banned')
        }
        function log(u: U) {
          if (u.admin) console.log('admin')
        }
        async function load(id: string): Promise<{ user: U }> {
          if (id === '') throw new Error('no id')
          return { user: { admin: false, banned: false, name: id } }
        }
        export class Svc {
          private validateEmail(u: U) {
            if (!u.email) throw new Error('email')
          }
          // @vantle: "Allowed?"
          async allowed(id: string, u: U): Promise<boolean> {
            assertNotBanned(u)
            this.validateEmail(u)
            Guard.check(u)
            log(u)
            const { user } = await load(id)
            if (user.admin) return true
            return u.admin
          }
        }`,
    })
    const flow = extract(dir)
    const decisions = flow.nodes.flatMap((n) => (n.kind === 'decision' ? [n.rawLabel] : []))
    expect(decisions).toEqual(expect.arrayContaining(['u.banned', 'u.email', 'u.name.length > 10', "id === ''", '(await load(id)).user.admin']))
    const throws = flow.nodes.flatMap((n) => (n.kind === 'outcome' && n.value?.startsWith('throw') ? [n.value] : []))
    expect(throws.sort()).toEqual(["throw new Error('banned')", "throw new Error('email')", "throw new Error('long')", "throw new Error('no id')"])
    // A helper that can't throw stays out of the chart, as before.
    expect(decisions).not.toContain('u.admin')
  })

  it('draws checks after side-effect-only branches once, with a step box for each change', () => {
    // PostHog's capture and Vendure's modifyOrder: each branch that changed \`this\`
    // led to its own copy of every later check, behind a step box listing every
    // change so far.
    const flow = one(`
      export class Q {
        x = 0; y = 0; z = 0
        // @vantle: "Q"
        q(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean): number {
          if (a) this.x = 1
          if (b) this.y = 1
          if (c) this.z = 1
          if (d) return 1
          if (e) return 2
          if (f) return 3
          return this.x + this.y + this.z
        }
      }`)
    const labels = flow.nodes.flatMap((n) => (n.kind === 'decision' ? [n.rawLabel] : []))
    expect(labels.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    const steps = flow.nodes.flatMap((n) => (n.kind === 'action' ? [n.rawLabel] : []))
    expect(steps.sort()).toEqual(['this changed (line 6)', 'this changed (line 7)', 'this changed (line 8)'])
  })

  it("doesn't show a changed value as its starting value after the paths meet", () => {
    // Payload's checkFileRestrictions: after "errors changed (line 194)" the arrows
    // led into a step box saying \`errors = []\`, hiding what the final throw decides.
    const flow = one(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean): string {
        const errors: string[] = []
        if (a) errors.push('a')
        if (b) errors.push('b')
        if (c) return 'c'
        if (d) return 'd'
        if (e) return 'e'
        if (f) return 'f'
        if (errors.length > 0) throw new Error(errors.join())
        return 'ok'
      }`)
    const byId = new Map(flow.nodes.map((n) => [n.id, n]))
    const out = new Map<string, string[]>()
    for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    // Walk every path: once a step box says errors changed, none may say it's [] again.
    const walk = (id: string, changed: boolean): void => {
      const n = byId.get(id)!
      const label = n.kind === 'action' ? n.rawLabel : ''
      if (changed) expect(label).not.toMatch(/errors = \[\]/)
      const now = changed || /errors changed/.test(label)
      for (const to of out.get(id) ?? []) walk(to, now)
    }
    walk(flow.root, false)
    expect(flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === 'errors.length > 0')).toBe(true)
  })

  it("doesn't treat a call to a method that changes nothing as a change to \`this\`", () => {
    // Vendure's modifyOrder: every \`this.check(...)\` marked \`this\` changed, so each later
    // check of \`this\` was drawn again on every branch.
    const flow = one(`
      export class Svc {
        enabled = true
        private note(x: number) { console.log(x) }
        private bump() { this.enabled = !this.enabled }
        // @vantle: "Q"
        q(a: boolean, b: boolean): number {
          if (a) this.note(1)
          if (this.enabled) return 1
          if (b) this.bump()
          if (this.enabled) return 2
          return 0
        }
      }`)
    const enabled = flow.nodes.filter((n) => n.kind === 'decision' && n.rawLabel === 'this.enabled')
    // Once before the bump and once after it on each side of \`b\`: three, not five.
    expect(enabled.length).toBe(3)
  })

  it('lists a helper that can throw instead of drawing it when its checks would swamp the chart', () => {
    const checks = Array.from({ length: 12 }, (_, i) => `if (u.f${i}) throw new Error('f${i}')`).join('\n        ')
    const flow = one(`
      type U = { admin: boolean; ${Array.from({ length: 12 }, (_, i) => `f${i}: boolean`).join('; ')} }
      function assertValid(u: U) {
        ${checks}
      }
      // @vantle: "Allowed?"
      export function allowed(u: U): boolean {
        assertValid(u)
        return u.admin
      }`)
    expect(flow.nodes.filter((n) => n.kind === 'decision' && n.rawLabel.startsWith('u.f'))).toHaveLength(0)
    expect(flow.notCharted?.map((n) => n.code)).toContain('assertValid(u)')
  })

  it('draws a helper that can throw when it is called inside the arguments of another call', () => {
    // Documenso: \`findFirst({ where: unsafeBuildEnvelopeIdQuery(id) })\` hid the "Invalid envelope ID" throw.
    const flow = one(`
      declare const db: { find(q: { where: string }): Promise<{ ok: boolean }> }
      function buildQuery(id: string): string {
        if (!id.startsWith('env_')) throw new Error('Invalid envelope ID')
        return id
      }
      // @vantle: "Found?"
      export async function found(id: string, fast: boolean): Promise<boolean> {
        const row = await db.find({ where: buildQuery(id) })
        if (fast) return true
        return row.ok
      }`)
    expect(flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === "id.startsWith('env_')")).toBe(true)
    expect(flow.nodes.some((n) => n.kind === 'outcome' && n.value === "throw new Error('Invalid envelope ID')")).toBe(true)
  })

  it("doesn't drop a check whose only effect is a variable used later", () => {
    // Medusa's prepareLineItemData: the sale-price check sets compareAtUnitPrice, which
    // goes into the returned line item, and was dropped with nothing listed.
    const flow = one(`
      type V = { onSale: boolean; price: number; original: number }
      // @vantle: "Line?"
      export function line(v: V, valid: boolean) {
        if (!valid) throw new Error('invalid')
        let compareAt: number | undefined
        if (v.onSale) compareAt = v.original
        const item: Record<string, unknown> = { price: v.price, compareAt }
        return item
      }`)
    // Drawn, or listed when the chart can't tell the results apart: never neither.
    const drawn = flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === 'v.onSale')
    const listed = (flow.notCharted ?? []).some((n) => n.code === 'if (v.onSale)')
    expect(drawn || listed).toBe(true)
  })

  it('lists a helper that throws from a callback', () => {
    const flow = one(`
      declare function match<T>(v: T): { with(p: unknown, fn: () => string): { run(): string } }
      function idQuery(id: string): string {
        return match(id).with('x', () => { throw new Error('Invalid envelope ID') }).run()
      }
      // @vantle: "Q"
      export function q(id: string, fast: boolean): string {
        const where = idQuery(id)
        if (fast) return 'fast'
        return where
      }`)
    expect(flow.notCharted?.some((n) => n.kind === 'callback' && n.code === 'idQuery(id)')).toBe(true)
  })

  it('keeps the parentheses around a substituted \`as\` expression', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(raw: string): boolean {
        const sizes = JSON.parse(raw) as Record<string, { n: number }>
        if (sizes.a!.n > 0) return true
        return false
      }`)
    const labels = flow.nodes.flatMap((n) => (n.kind === 'decision' ? [n.rawLabel] : []))
    expect(labels.some((l) => l.startsWith('(JSON.parse(raw) as Record<string, { n: number }>)'))).toBe(true)
  })

  describe('throws and catches the first fixes missed (review of extractor-fixes)', () => {
    const decisions = (flow: RawFlow) => flow.nodes.flatMap((n) => (n.kind === 'decision' ? [n.rawLabel] : []))
    const listed = (flow: RawFlow) => (flow.notCharted ?? []).map((n) => `${n.kind} ${n.code}`)

    it('lists a catch no drawn throw reaches', () => {
      const flow = one(`
        // @vantle: "Valid?"
        export function valid(s: string): boolean {
          try {
            new URL(s)
          } catch {
            return false
          }
          return true
        }`)
      expect(listed(flow)).toContain('catch catch')
    })

    it('lists a finally that decides something', () => {
      const flow = one(`
        // @vantle: "Q"
        export function q(x: number): string {
          try {
            if (x < 0) return 'neg'
          } finally {
            if (x > 100) return 'big'
          }
          return 'ok'
        }`)
      expect(listed(flow)).toContain('catch finally')
    })

    it('finds throws through returns, recursion and deep chains', () => {
      const flow = one(`
        function inner(x: number): number { if (x < 0) throw new Error('neg'); return x }
        function outer(x: number): number { return inner(x) * 2 }
        function a(n: number): void { if (n > 0) b(n - 1) }
        function b(n: number): void { if (n === 3) throw new Error('three'); a(n) }
        // @vantle: "Q"
        export function q(x: number, n: number, y: boolean): string {
          outer(x)
          a(n)
          if (y) return 'y'
          return 'n'
        }`)
      expect(decisions(flow)).toContain('x < 0')
      expect(decisions(flow).includes('n === 3') || listed(flow).some((l) => l.includes('a(n)'))).toBe(true)
    })

    it('draws throwing helpers inside returns, conditions and later declarators', () => {
      const flow = one(`
        function assertPos(x: number): number { if (x <= 0) throw new Error('pos'); return x }
        function load(k: string): string { if (k === '') throw new Error('empty'); return k }
        // @vantle: "Q"
        export function q(x: number, k: string, y: boolean): string {
          const a = 1, b = load(k)
          if (Math.abs(assertPos(x)) > 10 && y) return b
          return String(assertPos(a))
        }`)
      expect(decisions(flow)).toEqual(expect.arrayContaining(["k === ''", 'x <= 0']))
    })

    it("draws or lists the throws of a returned call that isn't drawn as a value", () => {
      // Novu's AddAgentIntegration: \`return this.provisionVanityInbox(...)\` was too big to draw, and its throws vanished.
      const checks = Array.from({ length: 45 }, (_, i) => `if (k === 'v${i}') return 'r${i}'`).join('\n          ')
      const flow = one(`
        function provision(k: string): string {
          if (k === '') throw new Error('empty')
          ${checks}
          return k
        }
        // @vantle: "Q"
        export function q(k: string, y: boolean): string {
          if (y) return 'y'
          return provision(k)
        }`)
      expect(decisions(flow).includes("k === ''") || listed(flow).includes('effect provision(k)')).toBe(true)
    })

    it('lists a helper that can throw but only runs on some paths', () => {
      const flow = one(`
        function assertOk(u: { ok: boolean }): boolean { if (!u.ok) throw new Error('no'); return true }
        // @vantle: "Q"
        export function q(u: { ok: boolean; admin: boolean }, check: boolean): boolean {
          const fine = check && assertOk(u)
          return u.admin
        }`)
      expect(listed(flow)).toContain('effect assertOk(u)')
    })

    it("keeps the caller's variables when a helper throws into its catch", () => {
      const flow = one(`
        function check(x: number) { if (x < 0) throw new Error('neg') }
        // @vantle: "Mode?"
        export function q(flag: boolean, x: number): string {
          let mode = 'a'
          if (flag) mode = 'b'
          try {
            check(x)
          } catch {
            return mode
          }
          return 'ok'
        }`)
      const outcomes = flow.nodes.flatMap((n) => (n.kind === 'outcome' ? [n.value] : [])).sort()
      expect(outcomes).toEqual(["'a'", "'b'", "'ok'"])
    })

    it('keeps different throws apart through a catch that only rethrows', () => {
      const flow = one(`
        // @vantle: "Q"
        export function q(x: number): string {
          try {
            if (x < 0) throw new Error('neg')
            if (x > 9) throw new Error('big')
          } catch (e) {
            console.log(e)
            throw e
          }
          return 'ok'
        }`)
      const throws = flow.nodes.flatMap((n) => (n.kind === 'outcome' && n.value?.startsWith('throw') ? [n.value] : [])).sort()
      expect(throws).toEqual(["throw new Error('big')", "throw new Error('neg')"])
    })

    it('sees a change to this made in a return, so the check that makes it stays drawn', () => {
      const flow = one(`
        export class C {
          n = 0
          bump() { return this.n++ }
          // @vantle: "Q"
          q(c: boolean): boolean {
            if (c) this.bump()
            return this.n > 0
          }
        }`)
      expect(decisions(flow)).toContain('c')
    })

    it('keeps outcome ids when unrelated code moves', () => {
      const src = (pad: string) => `${pad}
        // @vantle: "Q"
        export function q(a: boolean, b: boolean) {
          let cfg = { level: 1 }
          if (a) cfg = { level: 2 }
          if (b) return 'b'
          return cfg
        }`
      const ids = (pad: string) => one(src(pad)).nodes.filter((n) => n.kind === 'outcome').map((n) => n.id).sort()
      expect(ids('const unrelated = 1')).toEqual(ids(''))
    })
  })

  it("doesn't draw a helper under ?: or && as always running", () => {
    const flow = one(`
      function assertOk(u: { ok: boolean }) {
        if (!u.ok) throw new Error('not ok')
        return true
      }
      // @vantle: "Q"
      export function q(u: { ok: boolean; admin: boolean }, check: boolean): boolean {
        const fine = check && assertOk(u)
        return u.admin
      }`)
    expect(flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === 'u.ok')).toBe(false)
  })

  it('lists a callback that can throw, and draws a guard a catch handles', () => {
    const flow = one(`
      declare const db: { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }
      function assertOk(u: { ok: boolean }) {
        if (!u.ok) throw new Error('not ok')
      }
      // @vantle: "Q"
      export async function q(u: { ok: boolean; admin: boolean }): Promise<boolean> {
        try {
          assertOk(u)
        } catch {
          console.log('ignored')
        }
        await db.transaction(async () => {
          if (!u.admin) throw new Error('race')
        })
        return u.admin
      }`)
    const notes = (flow.notCharted ?? []).map((n) => `${n.kind} ${n.code}`)
    expect(notes.some((n) => n.startsWith('callback db.transaction('))).toBe(true)
    // The guard's throw goes into the catch, which logs and carries on, so both sides meet again.
    expect(flow.nodes.some((n) => n.kind === 'outcome' && n.value === "throw new Error('not ok')")).toBe(false)
  })

  it("sends a helper's throws into the catch that handles them", () => {
    const flow = one(`
      type U = { admin: boolean; banned: boolean }
      function assertNotBanned(u: U) {
        if (u.banned) throw new Error('banned')
      }
      // @vantle: "Allowed?"
      export function allowed(u: U): boolean {
        try {
          assertNotBanned(u)
        } catch {
          return false
        }
        return u.admin
      }`)
    // Banned users throw, the catch returns false: the chart says so, and there's no throw outcome.
    const banned = flow.nodes.find((n) => n.kind === 'decision' && n.rawLabel === 'u.banned')!
    const to = (label: string) => flow.nodes.find((n) => n.id === flow.edges.find((e) => e.from === banned.id && e.label === label)?.to)
    expect(to('yes')).toMatchObject({ kind: 'outcome', value: 'false' })
    expect(flow.nodes.some((n) => n.kind === 'outcome' && n.value?.startsWith('throw'))).toBe(false)
  })

  it('keeps returns apart when they read the same but a named local holds something different', () => {
    // Immich's checkOtherAccess: \`return isOwner.union(isShared)\` in the Viewer
    // and Editor cases was one outcome, so the chart said viewers could update albums.
    const flow = one(`
      declare const access: { checkOwner(u: string, ids: Set<string>): Promise<Set<string>>; checkShared(u: string, ids: Set<string>, role: 'viewer' | 'editor'): Promise<Set<string>> }
      // @vantle: "Allowed?"
      export async function can(p: 'read' | 'update', userId: string, ids: Set<string>) {
        switch (p) {
          case 'read': {
            const isOwner = await access.checkOwner(userId, ids)
            const isShared = await access.checkShared(userId, new Set([...ids].filter((x) => !isOwner.has(x) && x.length > 0 && !x.startsWith('deleted:') && !x.startsWith('archived:'))), 'viewer')
            return isOwner.union(isShared)
          }
          case 'update': {
            const isOwner = await access.checkOwner(userId, ids)
            const isShared = await access.checkShared(userId, new Set([...ids].filter((x) => !isOwner.has(x) && x.length > 0 && !x.startsWith('deleted:') && !x.startsWith('archived:'))), 'editor')
            return isOwner.union(isShared)
          }
        }
        return new Set<string>()
      }`)
    const sw = flow.nodes.find((n) => n.kind === 'decision' && n.rawLabel === 'p')!
    const to = (label: string) => flow.edges.find((e) => e.from === sw.id && e.label === label)?.to
    expect(to("'read'")).toBeDefined()
    expect(to("'read'")).not.toBe(to("'update'"))
  })

  it("doesn't drop checks whose branches differ only in values it stopped tracking", () => {
    // Medusa's prepareLineItemData: once the limit was hit, "no" at the first
    // optional field went straight to the return, past the checks after it.
    const flow = one(`
      type D = { a?: boolean; b?: boolean; c?: boolean; d?: boolean; q?: number }
      // @vantle: "Line?"
      export function make(data: D) {
        const { a, b, c, d } = data
        if (data.q !== undefined && data.q <= 0) throw new Error('q')
        let line: any = { q: data.q }
        if (a) line.a = true
        if (b) line.b = true
        if (c) line.c = true
        if (d) line.d = true
        return line
      }`)
    const graph = toGraph(flow.root, flow.nodes, flow.edges)
    const { paths } = enumeratePaths(graph, 10_000)
    const text = (id: string) => (graph.nodes.get(id)?.test ?? '').replace(/^data\./, '')
    // Every path that gets past the throw checks all four fields, in order.
    for (const p of paths.filter((p) => graph.nodes.get(p.outcome)?.value?.startsWith('line'))) {
      expect(p.steps.map((s) => text(s.node)).filter((t) => /^[abcd]$/.test(t))).toEqual(['a', 'b', 'c', 'd'])
    }
    expect(flow.notCharted ?? []).toEqual([])
  })
})

describe('drawing shared checks once', () => {
  const source = `
    declare function lookup(id: string): number
    declare function pick(id: string): number
    // @vantle: "Q"
    export function q(sticky: boolean, a: boolean, b: boolean, c: boolean, d: boolean, id: string): string {
      let found = false
      let assigned = -1
      if (sticky) {
        assigned = lookup(id)
        found = assigned >= 0
      }
      if (!found) {
        if (a) return 'filtered'
        if (b) return 'filtered'
        if (c) return 'filtered'
        if (d) return 'filtered'
        assigned = pick(id)
      }
      if (assigned < 0) return 'none'
      return 'in'
    }`

  it('draws checks once after branches that set variables differently', () => {
    const flow = one(source)
    const labels = decisions(flow)
    // Both branches reach the same checks, and \`assigned\` is set again before it's read,
    // so the copies are identical and merge into one.
    for (const check of ['a', 'b', 'c', 'd']) expect(labels.filter((l) => l === check)).toHaveLength(1)
    expect(labels.filter((l) => l === 'pick(id) < 0')).toHaveLength(1)
  })

  it('uses step boxes when the branches differ in a value read after the shared checks', () => {
    const flow = one(`
      declare function lookup(id: string): number
      // @vantle: "Q"
      export function q(sticky: boolean, a: boolean, b: boolean, c: boolean, d: boolean, id: string): string {
        let assigned = -1
        if (sticky) assigned = lookup(id)
        if (a) return 'filtered'
        if (b) return 'filtered'
        if (c) return 'filtered'
        if (d) return 'filtered'
        if (assigned < 0) return 'none'
        return 'in'
      }`)
    for (const check of ['a', 'b', 'c', 'd']) expect(decisions(flow).filter((l) => l === check)).toHaveLength(1)
    expect(flow.nodes.filter((n) => n.kind === 'action').map((n) => n.rawLabel).sort()).toEqual(['assigned = -1', 'assigned = lookup(id)'])
    expect(flow.warnings.join(' ')).toMatch(/drawn once for every branch/)
  })

  it("rules out paths that contradict what a step set", () => {
    const flow = one(`
      declare function lookup(id: string): boolean
      // @vantle: "Q"
      export function q(sticky: boolean, a: boolean, b: boolean, c: boolean, d: boolean, id: string): string {
        let found = false
        if (sticky) found = lookup(id)
        if (a) return 'x'
        if (b) return 'x'
        if (c) return 'x'
        if (d) return 'x'
        if (found) return 'sticky'
        return 'normal'
      }`)
    expect(decisions(flow)).toContain('found')
    const graph = toGraph(flow.root, flow.nodes, flow.edges)
    const { paths } = enumeratePaths(graph, 10_000)
    const byId = new Map(flow.nodes.map((n) => [n.id, n]))
    // With sticky = no, the step sets found = false, so no path can then answer found = yes.
    let checked = 0
    for (const p of paths) {
      const sticky = p.steps.find((s) => byId.get(s.node)?.rawLabel === 'sticky')
      const found = p.steps.find((s) => byId.get(s.node)?.rawLabel === 'found')
      if (sticky?.edge === 'no' && found) {
        checked++
        expect(found.edge).toBe('no')
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('draws checks once after a long run of branches that each change the same object', () => {
    // A long run of optional updates, each setting one field on the same object, then
    // checks that read the object. Widening one join per extraction ran out of extractions
    // before the run ended, so later checks were drawn once per mix of fields set.
    // (The original repro was an update handler in a public repo; this is a synthetic
    // function with the same shape.)
    const flow = one(`interface Listing {
  id: string; shopId: string; live: boolean; folder?: string | null
  name: string; price?: number; currency?: string; badge?: string | null; summary?: string
  stock?: number; tags?: string[]; options?: Record<string, unknown> | null; featured?: boolean
  editedBy?: string
  isDirty(field?: string): boolean
  refresh(o: unknown): Promise<void>
  store(o?: unknown): Promise<void>
  release(o: unknown): Promise<void>
}
type Patch = {
  listing: Listing; name?: string; price?: number; currency?: string; badge?: string | null
  summary?: string; stock?: number; tags?: string[]; options?: Record<string, unknown> | null
  featured?: boolean; body?: string; expectedVersion?: number; retireNote?: string
  goLive?: boolean; folder?: string | null; notify?: boolean
}
type Ctx = { userId: string; tx?: { lockMode: unknown } }
declare function StaleVersion(): Error
declare function NotAllowed(m: string): Error
declare const Listings: { claim(id: string, version: number | undefined, tx: unknown): Promise<unknown>; byId(id: string, o: unknown): Promise<Listing> }
declare const Markup: { render(l: Listing, body: string): Listing; sanitize(body: string, userId: string): Promise<string> }
declare const Outbox: { enqueue(e: unknown): Promise<void> }
// @vantle: "Q"
export async function patchListing(ctx: Ctx, p: Patch): Promise<Listing> {
  let { listing } = p
  const folder = p.folder ?? listing.folder
  if (p.name !== undefined) listing.name = p.name.trim()
  if (p.price !== undefined) listing.price = p.price
  if (p.currency) listing.currency = p.currency
  if (p.badge !== undefined) listing.badge = p.badge
  if (p.summary) listing.summary = p.summary
  if (p.stock !== undefined) listing.stock = p.stock
  if (p.tags) listing.tags = [...(listing.tags ?? []), ...p.tags]
  if (p.options !== undefined) listing.options = p.options
  if (p.featured !== undefined) listing.featured = p.featured
  if (p.body !== undefined) {
    listing = Markup.render(listing, await Markup.sanitize(p.body, ctx.userId))
  }
  if (ctx.tx) {
    const claimed = await Listings.claim(listing.id, p.expectedVersion, ctx.tx)
    if (!claimed && p.expectedVersion !== undefined) throw StaleVersion()
  }
  if (p.retireNote !== undefined) {
    await listing.refresh({ tx: ctx.tx })
    if (listing.live) throw NotAllowed('take the listing down first')
    if (listing.isDirty('summary')) await listing.store({ quiet: true })
    return listing
  }
  const dirty = listing.isDirty()
  const shopId = listing.shopId
  if (p.goLive && folder) {
    if (!listing.folder) listing.folder = folder
    await listing.release({ folder })
  } else if (dirty) {
    listing.editedBy = ctx.userId
    await listing.store()
  } else if (p.notify) {
    await Outbox.enqueue({ kind: 'listing.touched', id: listing.id, shopId })
  }
  if (p.goLive || listing.folder !== folder) {
    return await Listings.byId(listing.id, { tx: ctx.tx })
  }
  return listing
}`)
    const labels = decisions(flow)
    for (const field of ['name', 'price', 'currency', 'badge', 'summary', 'stock', 'tags', 'options', 'featured']) {
      expect(labels.filter((l) => l === `p.${field}` || l === `p.${field} !== undefined`)).toHaveLength(1)
    }
    expect(labels.length).toBeLessThanOrEqual(25)
  })

  it("doesn't draw a step box for a value an earlier join already forgot", () => {
    // \`path\` is normalized on one branch, then every later join forgot it again and drew
    // \`path = path\`, which says nothing. (Synthetic; the original repro was a URL router.)
    const flow = one(`      declare function mirror(path: string): string | undefined
      declare function finish(kind: string, path: string, url: string): string
      // @vantle: "Q"
      export function routeFor(kind: string, selfHosted: boolean, zone: string, path: string = ''): string {
        if (path) {
          path = path.startsWith('/') ? path : '/' + path
        }
        if (kind === 'docs') return finish(kind, path, 'docs' + path)
        if (kind === 'status') return finish(kind, path, 'status' + path)
        if (kind === 'media') {
          const m = mirror(path)
          if (m) return finish(kind, path, m + path)
        }
        if (selfHosted) return finish(kind, path, 'local' + path)
        const host = 'example.net' + path
        switch (kind) {
          case 'media':
            return finish(kind, path, \`https://media-\${zone}.\${host}\`)
          case 'rest':
            return finish(kind, path, \`https://\${zone}.\${host}\`)
        }
        return ''
      }`)
    const steps = flow.nodes.filter((n) => n.kind === 'action').map((n) => n.rawLabel)
    expect(steps).not.toContain('path = path')
    expect(steps).toContain("path = path.startsWith('/') ? path : '/' + path")
  })

  it('stays precise when keeping branches apart costs little', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): boolean {
        let blocked = false
        if (a) blocked = true
        if (blocked) return false
        return b
      }`)
    expect(flow.nodes.some((n) => n.kind === 'action')).toBe(false)
    expect(decisions(flow).sort()).toEqual(['a', 'b'])
  })
})

describe('long arguments', () => {
  const source = `
    declare function load(id: string, opts: { projection: { name: number; email: number } }): Promise<{ name: string } | undefined>
    function isSolo(members: unknown[]): boolean {
      if (members.length === 1) return true
      return members.some((m) => typeof m === 'string')
    }
    // @vantle: "Q"
    export async function q(id: string, other: string, users: string[]): Promise<boolean> {
      if (id === other) return isSolo([await load(id, { projection: { name: 1, email: 1 } }), ...users])
      return isSolo([await load(other, { projection: { name: 1, email: 1 } }), ...users])
    }`

  it("shows a helper's parameter by name when the argument is long", () => {
    const flow = one(source)
    expect(decisions(flow).filter((l) => l === 'members.length === 1')).toHaveLength(2)
    expect(decisions(flow).every((l) => l.length <= 60)).toBe(true)
  })

  // Review of chart-size: once a long argument is shown by name, its key is all that tells
  // two calls apart. Each case lost it somewhere and merged two objects into one question.
  const reg = `interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
    type Ctx = { registry: Reg; tenantIdentifier: string }`
  const call = (v: string) => `${v}.registry.lookupPrimaryWidgetForTenantWithFallback(${v}.tenantIdentifier, 'eu')`
  const reachesAll = (flow: RawFlow) => {
    const reached = new Set(flow.paths.map((p) => p.outcome))
    return flow.nodes.filter((n) => n.kind === 'outcome').every((n) => reached.has(n.id))
  }
  it.each([
    ['a long receiver shown as `this`', `class W { enabled = false; legacy = false; isOn(): boolean { if (this.enabled) return true; return this.legacy } }
      ${reg}
      // @vantle: "Q"
      export function entry(x: Ctx, y: Ctx): string {
        if (${call('x')}.isOn()) return 'a'
        if (${call('y')}.isOn()) return 'b'
        return 'c'
      }`, 5],
    ['a helper changing its argument', `interface W { hits: number; ready: boolean }
      ${reg}
      function touch(w: W): boolean { w.hits = w.hits + 1; if (w.ready) return true; if (w.hits > 3) return true; return false }
      // @vantle: "Q"
      export function entry(x: Ctx, y: Ctx): string {
        if (touch(${call('x')})) return 'A'
        if (touch(${call('y')})) return 'B'
        return 'C'
      }`, 5],
    ['a join inside the helper', `interface W { a: number; b: number; done: boolean; live: boolean }
      ${reg}
      function touch(w: W, p: boolean, q: boolean): boolean {
        if (p) w.a = 1
        if (q) w.b = 2
        if (w.a > 0) return true
        if (w.b > 0) return true
        if (w.done) return true
        if (w.live) return true
        return false
      }
      // @vantle: "Q"
      export function entry(p: boolean, q: boolean, x: Ctx, y: Ctx): string {
        if (touch(${call('x')}, p, q)) return 'A'
        if (touch(${call('y')}, p, q)) return 'B'
        return 'C'
      }`, 36],
    ['an expression of the argument passed on, and a default built from it', `interface C { on: boolean }
      interface W { cfg: C; kind: string; off: boolean }
      ${reg}
      function inner(c: C): boolean { if (c.on) return true; return false }
      function outer(w: W): boolean { if (w.off) return false; return inner(w.cfg) }
      function kindOf(w: W, k = w.kind): boolean { if (k === 'big') return true; return false }
      // @vantle: "Q"
      export function entry(x: Ctx, y: Ctx): string {
        if (outer(${call('x')})) return 'A'
        if (outer(${call('y')})) return 'B'
        if (kindOf(${call('x')})) return 'C'
        if (kindOf(${call('y')})) return 'D'
        return 'E'
      }`, 15],
    ["the entry's own `this` and a receiver shown as `this`", `class W { enabled = false; isOn(): boolean { if (this.enabled) return true; return false } }
      interface Reg { lookupPrimaryWidgetForTenantWithFallback(id: string, region: string): W }
      export class Svc {
        enabled = true
        registry!: Reg
        // @vantle: "Q"
        decide(tenantIdentifier: string): string {
          if (this.enabled) return 'self-on'
          if (this.registry.lookupPrimaryWidgetForTenantWithFallback(tenantIdentifier, 'eu').isOn()) return 'widget-on'
          return 'off'
        }
      }`, 3],
  ])('keeps different objects apart through %s', (_, source, paths) => {
    const flow = one(source)
    expect(flow.pathCount).toBe(paths)
    expect(reachesAll(flow)).toBe(true)
  })

  it('keeps calls with different long arguments apart', () => {
    const flow = one(source)
    const boxes = flow.nodes.filter((n) => n.kind === 'decision' && n.rawLabel === 'members.length === 1')
    expect(boxes).toHaveLength(2)
    const ids = boxes.map((n) => (n.kind === 'decision' ? n.identity : undefined))
    expect(ids[0]).toBeDefined()
    expect(ids[0]).not.toBe(ids[1])
  })
})

describe('values read before a change', () => {
  it("keeps a constant's name when what it was read from changes before it's used", () => {
    // Vendure's modifyOrder: `const initialTotalWithTax = order.totalWithTax`, then the order
    // changes, then `newTotal - initialTotalWithTax < 0` read as `order.totalWithTax - order.totalWithTax`.
    const flow = one(`
      interface Order { total: number }
      declare function addItem(o: Order): void
      // @vantle: "Q"
      export function q(order: Order): string {
        const before = order.total
        addItem(order)
        if (order.total - before < 0) return 'refund'
        return 'charge'
      }`)
    expect(decisions(flow)).toEqual(['order.total - before < 0'])
  })

  it('spells a constant out when nothing it reads changes', () => {
    const flow = one(`
      interface Order { total: number }
      declare function log(o: string): void
      // @vantle: "Q"
      export function q(order: Order): string {
        const before = order.total
        log('x')
        if (before > 5) return 'big'
        return 'small'
      }`)
    expect(decisions(flow)).toEqual(['order.total > 5'])
  })

  it("doesn't add parentheses around a call chain", () => {
    const flow = one(`
      function blocked(name: string): boolean {
        if (name.trim() === 'root') return true
        return false
      }
      // @vantle: "Q"
      export function q(raw: unknown): boolean {
        const name = String(raw).trim()
        return blocked(name)
      }`)
    expect(decisions(flow)).toEqual(["String(raw).trim().trim() === 'root'"])
  })

  it('keeps parentheses around a substituted variable holding a ternary', () => {
    const flow = one(`
      interface Req { url: string }
      declare function isReq(x: unknown): x is Req
      function base(request: Req | undefined): boolean {
        if (request?.url) return true
        return false
      }
      // @vantle: "Q"
      export function q(source: unknown): boolean {
        const request = isReq(source) ? source : undefined
        return base(request)
      }`)
    expect(decisions(flow).join(' ')).toContain('(isReq(source) ? source : undefined)?.url')
  })
})

describe('box budget', () => {
  const source = `
    function inner(x: number): boolean {
      if (x > 10) return true
      if (x > 5) return false
      if (x > 3) return true
      return x > 1
    }
    function middle(x: number): boolean {
      if (x < 0) return false
      return inner(x)
    }
    // @vantle: "Q"
    export function top(x: number, y: number): boolean {
      if (y > 0) return middle(x)
      return middle(y)
    }`

  it('follows helpers less deep when that brings the chart under the budget', () => {
    const full = extract(tempProject({ 'main.ts': source }))
    expect(decisions(full)).toHaveLength(11)
    const flow = extract(tempProject({ 'main.ts': source }), undefined, { maxBoxes: 6 })
    // middle is still drawn at both call sites; inner, two calls deep, is one box each.
    expect(decisions(flow).sort()).toEqual(['inner(x)', 'inner(y)', 'x < 0', 'y < 0', 'y > 0'])
    expect(flow.warnings.join(' ')).toMatch(/more than 1 call deep are shown as one box each, to keep the chart under 6 boxes/)
  })

  it("doesn't tell the reader to raise --depth when the budget set the depth", () => {
    const flow = extract(tempProject({ 'main.ts': source }), undefined, { maxBoxes: 6 })
    expect(flow.warnings.join(' ')).not.toMatch(/Raise --depth/)
  })

  it('records the options it used, so re-extracting reads the same files', () => {
    const dir = tempProject({
      'deep.ts': `export function deep(n: number): boolean { if (n > 5) return true; if (n > 3) return true; return n > 1 }`,
      'mid.ts': `import { deep } from './deep'\nexport function mid(n: number): boolean { if (n < 0) return false; if (n === 7) return true; return deep(n) }`,
      'main.ts': `import { mid } from './mid'
        // @vantle: "Q"
        export function entry(a: number, b: number): string { if (mid(a)) return 'A'; if (mid(b)) return 'B'; return 'C' }`,
    })
    const budgeted = extract(dir, undefined, { maxBoxes: 8 })
    expect(budgeted.flow.extractOptions?.maxBoxes).toBe(8)
    // Only the files drawn are hashed, so the default (no collapsed helpers) hashes differently.
    expect(extract(dir).flow.sourceHash).not.toBe(budgeted.flow.sourceHash)
    expect(extract(dir, undefined, { ...budgeted.flow.extractOptions }).flow.sourceHash).toBe(budgeted.flow.sourceHash)
  })

  it('draws a chart in full when no depth fits', () => {
    const flow = extract(tempProject({ 'main.ts': source }), undefined, { maxBoxes: 3 })
    expect(decisions(flow)).toHaveLength(11)
    expect(flow.warnings.join(' ')).not.toMatch(/to keep the chart under/)
  })

  it('uses the deepest depth that fits', () => {
    const flow = extract(tempProject({ 'main.ts': `
      function leaf(x: number): boolean {
        if (x > 10) return true
        if (x > 5) return false
        return x > 1
      }
      function inner(x: number): boolean {
        if (x === 7) return false
        return leaf(x)
      }
      function middle(x: number): boolean {
        if (x < 0) return false
        return inner(x)
      }
      // @vantle: "Q"
      export function top(x: number): boolean {
        if (x === 0) return true
        return middle(x)
      }` }), undefined, { maxBoxes: 4 })
    // In full it's 7 boxes; leaf as one box makes 4, which fits; inner as one box (3) would too, but hides more.
    expect(decisions(flow).sort()).toEqual(['leaf(x)', 'x < 0', 'x === 0', 'x === 7'])
    expect(flow.warnings.join(' ')).toMatch(/more than 2 calls deep/)
  })
})

describe('behavior comparison', () => {
  const graph = (nodes: Record<string, { test?: string; switch?: boolean; edges?: [string, string][]; value?: string }>, root: string): Graph => ({
    root,
    nodes: new Map(
      Object.entries(nodes).map(([id, n]) => [
        id,
        n.value !== undefined
          ? { id, kind: 'outcome' as const, value: n.value, edges: [] }
          : { id, kind: 'decision' as const, branch: n.switch ? ('switch' as const) : ('boolean' as const), test: n.test, edges: (n.edges ?? []).map(([label, to]) => ({ label, to })) },
      ]),
    ),
  })
  const T = { value: 'true' }
  const F = { value: 'false' }

  it('treats `x === lit` as a fact about the switch on x', () => {
    const viaSwitch = graph({ s: { test: 'mode', switch: true, edges: [["'a'", 'T'], ['default', 'F']] }, T, F }, 's')
    const viaCompare = graph({ c: { test: "mode === 'a'", edges: [['yes', 'T'], ['no', 'F']] }, T, F }, 'c')
    expect(compareBehavior(viaSwitch, viaCompare).equivalent).toBe(true)
  })

  it('ignores paths that contradict themselves', () => {
    // The second `a` check can only go "yes" after the first said yes.
    const g = graph({ a1: { test: 'a', edges: [['yes', 'a2'], ['no', 'F']] }, a2: { test: 'a', edges: [['yes', 'T'], ['no', 'F']] }, T, F }, 'a1')
    const simple = graph({ a: { test: 'a', edges: [['yes', 'T'], ['no', 'F']] }, T, F }, 'a')
    expect(compareBehavior(simple, g).equivalent).toBe(true)
    expect(compareBehavior(simple, g).actualPaths).toBe(2)
  })

  it('reports an input that tells two graphs apart', () => {
    const and = graph({ a: { test: 'a', edges: [['yes', 'b'], ['no', 'F']] }, b: { test: 'b', edges: [['yes', 'T'], ['no', 'F']] }, T, F }, 'a')
    const onlyA = graph({ a: { test: 'a', edges: [['yes', 'T'], ['no', 'F']] }, T, F }, 'a')
    const result = compareBehavior(and, onlyA)
    expect(result.equivalent).toBe(false)
    expect(result.counterexamples[0]).toEqual({ inputs: { a: 'true', b: 'false' }, expected: 'false', actual: 'true' })
  })
})

describe('outcome graph shape', () => {
  it('never shows unreachable boxes', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(a: boolean): boolean {
        return true
        if (a) return false
      }`)
    expect(decisions(flow)).toEqual([])
    expect(toGraph(flow.root, flow.nodes, flow.edges).nodes.size).toBe(1)
  })
})

describe('review round 1: charts that came out silently wrong', () => {
  const paths = (flow: RawFlow) => flow.paths.map((p) => `${p.steps.map((s) => `${flow.nodes.find((n) => n.id === s.node)!.rawLabel}=${s.edge}`).join(' ')} → ${flow.nodes.find((n) => n.id === p.outcome)!.rawLabel}`)

  it("walks a helper again when it's called with different arguments (A1)", () => {
    const flow = one(`
      function check(flag: boolean, b: boolean): boolean {
        if (flag) return true
        if (b) return true
        return false
      }
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): boolean {
        let x = false
        if (a) x = true
        return check(x, b)
      }`)
    expect(paths(flow).sort()).toEqual(['a=no b=no → false', 'a=no b=yes → true', 'a=yes → true'])
  })

  it('keeps a branch that changes an object through a method (A2)', () => {
    const flow = one(`
      // @vantle: "Allowed?"
      export function allowed(user: { banned: boolean; late: boolean }): boolean {
        const reasons: string[] = []
        if (user.banned) reasons.push('banned')
        if (user.late) reasons.push('late')
        if (reasons.length > 0) return false
        return true
      }`)
    expect(decisions(flow)).toEqual(expect.arrayContaining(['user.banned', 'user.late', 'reasons.length > 0']))
    expect(decisions(flow).some((d) => d.includes('[]'))).toBe(false)
  })

  it('draws a branch that sets a property of the returned object (A2)', () => {
    const flow = one(`
      // @vantle: "What response?"
      export function respond(stop: boolean, flag: boolean, res: { body: string }) {
        if (stop) return 'stop'
        if (flag) res.body = 'approved'
        else res.body = 'denied'
        return res
      }`)
    expect(paths(flow).sort()).toEqual(['stop=no flag=no → res (changed at line 6)', 'stop=no flag=yes → res (changed at line 5)', "stop=yes → 'stop'"])
    expect(flow.notCharted).toEqual([])
  })

  it("lists a branch whose only effect the chart can't follow as not charted", () => {
    const flow = one(`
      declare function save(u: { id: string }): void
      // @vantle: "Q"
      export function q(user: { id: string }, persist: boolean, ok: boolean): boolean {
        if (persist) save(user)
        return ok
      }`)
    expect(decisions(flow)).toEqual(['ok'])
    expect(flow.notCharted).toEqual([expect.objectContaining({ kind: 'effect', code: 'if (persist)' })])
  })

  it('treats checks before and after a property change as separate questions (A2)', () => {
    const flow = one(`
      // @vantle: "Q"
      export function q(opts: { elevated: boolean }, admin: boolean): string {
        if (opts.elevated) return 'already'
        if (admin) opts.elevated = true
        if (opts.elevated) return 'elevated'
        return 'normal'
      }`)
    // Without versions, "elevated" after "already = no" would be pruned as a contradiction.
    expect(paths(flow)).toContain('opts.elevated=no admin=yes opts.elevated=yes → \'elevated\'')
  })

  it('records the values of enum cases and knows an enum switch is exhaustive (A4)', () => {
    const flow = one(`
      enum Status { Active = 'active', Paused = 'paused' }
      // @vantle: "Label?"
      export function label(s: Status): string {
        switch (s) {
          case Status.Active:
            return 'on'
          case Status.Paused:
            return 'off'
        }
      }`)
    expect(edgesFrom(flow, 's')).toEqual(['Status.Active', 'Status.Paused'])
    expect(flow.edges.map((e) => e.value).filter(Boolean)).toEqual(['"active"', '"paused"'])
  })

  it("doesn't treat two calls of next() as one answer, or == as ===  (A5)", () => {
    const flow = one(`
      // @vantle: "What?"
      export function what(next: () => boolean): string {
        if (next()) {
          if (next()) return 'TT'
          return 'TF'
        }
        return 'F'
      }`)
    expect(flow.pathCount).toBe(3)
    const loose = one(`
      // @vantle: "What?"
      export function what(x: unknown): string {
        if (x == 1) {
          if (x === '1') return 'a'
        }
        return 'b'
      }`)
    expect(loose.pathCount).toBe(3)
  })

  it('tracks a parameter a helper reassigns, keeping calls with different arguments apart (A6)', () => {
    const flow = one(`
      type O = { strict?: boolean }
      function isStrict(opts?: O): boolean {
        opts = { strict: false, ...opts }
        if (opts.strict) return true
        return false
      }
      // @vantle: "Which?"
      export function which(a?: O, b?: O): string {
        if (isStrict(a)) return 'A'
        if (isStrict(b)) return 'B'
        return 'none'
      }`)
    expect(decisions(flow)).toEqual(['opts.strict', 'opts.strict'])
    expect(flow.pathCount).toBe(3)
    const defaults = one(`
      function over(n: number, limit = 10): boolean {
        if (n > limit) return true
        return n < 0
      }
      // @vantle: "Over?"
      export function f(n: number): boolean {
        return over(n)
      }`)
    expect(decisions(defaults)).toEqual(expect.arrayContaining(['n > 10']))
  })

  it('keeps calls of a helper apart when a callback in it reads its parameters (A8)', () => {
    const flow = one(`
      type U = { roles: string[] }
      function hasRole(user: U | undefined, role: string): boolean {
        if (!user) return false
        return user.roles.some((r) => r === role)
      }
      // @vantle: "Role?"
      export function role(u: U): string {
        if (hasRole(u, 'admin')) return 'a'
        if (hasRole(u, 'editor')) return 'e'
        return 'none'
      }`)
    expect(decisions(flow)).toEqual(expect.arrayContaining(["u.roles.some((r) => r === 'admin')", "u.roles.some((r) => r === 'editor')"]))
  })

  it('keeps the branches that fill a list when the checks after them are drawn once', () => {
    const flow = one(`
      type U = { c0: boolean; c1: boolean; x: boolean; y: boolean }
      // @vantle: "Allowed?"
      export function allowed(user: U): boolean {
        const reasons: string[] = []
        if (user.c0) reasons.push('c0')
        if (user.c1) reasons.push('c1')
        if (user.x) return true
        if (reasons.length > 0) return false
        return user.y
      }`)
    expect(decisions(flow)).toEqual(expect.arrayContaining(['user.c0', 'user.c1', 'user.x', 'reasons.length > 0']))
    expect(flow.nodes.filter((n) => n.kind === 'action').map((n) => n.rawLabel).sort()).toEqual(['reasons = []', 'reasons changed (line 6)', 'reasons changed (line 7)'])
  })

  it('names what a helper returns by the call when it returns its own variable', () => {
    const flow = one(`
      function make(kind: string, value: number) {
        if (value > 100) return null
        const out = { kind, value }
        return out
      }
      // @vantle: "Q"
      export function f(a: boolean, n: number) {
        if (a) return make('A', n)
        return make('B', n)
      }`)
    expect(outcomes(flow)).toEqual(expect.arrayContaining(["make('A', n) → out", "make('B', n) → out"]))
  })

  it('treats `this.x` and destructured properties as changed after a change', () => {
    const cls = one(`
      export class Svc {
        cache?: string
        load(): string { return 'x' }
        // @vantle: "Q"
        get(refresh: boolean): string {
          if (this.cache) return 'cached'
          if (refresh) this.cache = this.load()
          if (this.cache) return 'loaded'
          return 'none'
        }
      }`)
    expect(paths(cls)).toContain("this.cache=no refresh=yes this.cache=yes → 'loaded'")
    const destructured = one(`
      // @vantle: "Q"
      export function q(opts: { elevated: boolean }, admin: boolean): string {
        if (opts.elevated) return 'already'
        if (admin) opts.elevated = true
        const { elevated } = opts
        if (elevated) return 'elevated'
        return 'normal'
      }`)
    expect(paths(destructured)).toContain("opts.elevated=no admin=yes opts.elevated=yes → 'elevated'")
  })

  it('folds a switch on a known value only when every case is known, and reads switch (true) as an if chain', () => {
    const known = one(`
      const MODE_FAST = 'fast'
      const MODE_SLOW = 'slow'
      // @vantle: "Q"
      export function q(x: boolean): string {
        let mode = 'slow'
        if (x) mode = 'fast'
        switch (mode) {
          case MODE_FAST: return 'F'
          case MODE_SLOW: return 'S'
          default: return 'D'
        }
      }`)
    expect(paths(known).sort()).toEqual(["x=no → 'S'", "x=yes → 'F'"])
    const chain = one(`
      // @vantle: "Q"
      export function q(xs: number[]): string {
        switch (true) {
          case xs.length > 3: return 'many'
          case xs.length > 0: return 'some'
          default: return 'none'
        }
      }`)
    expect(decisions(chain).sort()).toEqual(['xs.length > 0', 'xs.length > 3'])
  })

  it('rewrites `this` in an inlined method to the object it was called on (A7)', () => {
    const flow = one(`
      class Gate {
        strict = false
        allows(x: number): boolean {
          if (this.strict) return x > 5
          return x > 0
        }
      }
      const gate = new Gate()
      // @vantle: "Allowed?"
      export function allowed(x: number): boolean {
        return gate.allows(x)
      }`)
    expect(decisions(flow).sort()).toEqual(['gate.strict', 'x > 0', 'x > 5'])
  })

  it("doesn't rewrite inside callbacks, and lists their checks as not charted (A8, A9)", () => {
    const flow = one(`
      // @vantle: "Big?"
      export function big(items: number[], limit: number): boolean {
        const min = limit * 2
        if (items.some((min) => min > 3)) return true
        return items.length > min
      }`)
    expect(decisions(flow).sort()).toEqual(['items.length > (limit * 2)', 'items.some((min) => min > 3)'])
    expect(flow.notCharted).toEqual([expect.objectContaining({ kind: 'callback', code: 'items.some((min) => min > 3)' })])
  })

  it('lists catch blocks as not charted', () => {
    const flow = one(`
      // @vantle: "Valid?"
      export function valid(text: string): boolean {
        try {
          JSON.parse(text)
        } catch {
          return false
        }
        return true
      }`)
    expect(flow.notCharted).toEqual([expect.objectContaining({ kind: 'catch', code: 'catch', line: 6 })])
  })

  it('stays whole after undoing a helper that was too big (A3)', () => {
    const flow = extract(
      tempProject({
        'main.ts': `
          function big(a: boolean, b: boolean, c: boolean): boolean {
            if (a) return true
            if (b) return true
            if (c) return true
            return false
          }
          // @vantle: "Q"
          export function q(x: boolean, a: boolean, b: boolean, c: boolean): boolean {
            let y = 0
            if (x) y = 1
            if (y > 0) return big(a, b, c)
            return big(a, b, c) && !x
          }`,
      }),
      undefined,
      { maxInline: 2 },
    )
    const ids = new Set(flow.nodes.map((n) => n.id))
    expect(flow.edges.every((e) => ids.has(e.to))).toBe(true)
    expect(flow.warnings.some((w) => w.includes('big is shown as one box'))).toBe(true)
  })

  it("doesn't split the chart on a change no later check reads", () => {
    const flow = one(`
      type Exp = { on: boolean; bandit?: object; weights?: number[]; stack: { seen?: string[] } }
      function merge(e: Exp): Exp { return { ...e } }
      // @vantle: "On?"
      export function on(exp: Exp, a: boolean, b: boolean): string {
        exp = merge(exp)
        if (exp.bandit && exp.weights) exp.bandit = { weights: exp.weights }
        exp.stack.seen = []
        if (a) return 'a'
        if (b) return 'b'
        exp.stack.seen = undefined
        if (exp.on) return 'on'
        return 'off'
      }`)
    expect(decisions(flow).sort()).toEqual(['a', 'b', 'exp.on'])
    expect(flow.notCharted).toEqual([expect.objectContaining({ kind: 'effect', code: 'if (exp.bandit && exp.weights)' })])
  })

  describe('changes nothing tracks still never rule out a path (second review)', () => {
    const outcomesOf = (flow: RawFlow) => flow.paths.map((p) => flow.nodes.find((n) => n.id === p.outcome)!.rawLabel)

    it('after a change seen only through a call inside && or a stored result', () => {
      const viaAnd = one(`
        type Order = { priority: string }
        declare function isValid(o: Order): boolean
        // @vantle: "Q"
        export function f(order: Order, rush: boolean, a: boolean): string {
          if (isValid(order) && a) return 'early'
          if (rush) order.priority = 'high'
          if (isValid(order) && a) return 'late'
          return 'ok'
        }`)
      expect(outcomesOf(viaAnd)).toContain("'late'")
      const stored = one(`
        type Order = { priority: string }
        declare function isValid(o: Order): boolean
        // @vantle: "Q"
        export function f(order: Order, rush: boolean): string {
          if (!isValid(order)) return 'invalid'
          if (rush) order.priority = 'high'
          const ok = isValid(order)
          if (!ok) return 'invalid-after'
          return 'ok'
        }`)
      expect(outcomesOf(stored)).toContain("'invalid-after'")
    })

    it("after a function it can't see into is given the object", () => {
      const flow = one(`
        type O = { strict?: boolean }
        declare function applyDefaults(o: O): void
        // @vantle: "Q"
        export function f(opts: O, fill: boolean): string {
          if (opts.strict) return 'strict'
          if (fill) applyDefaults(opts)
          if (opts.strict) return 'strict-after'
          return 'loose'
        }`)
      expect(outcomesOf(flow)).toContain("'strict-after'")
    })

    it('through an inlined method on this, and a helper that destructures its argument', () => {
      const method = one(`
        export class S {
          cache?: string
          has(): boolean { if (this.cache) return true; return false }
          // @vantle: "Q"
          get(refresh: boolean): string {
            if (this.has()) return 'cached'
            if (refresh) this.cache = 'x'
            if (this.has()) return 'loaded'
            return 'none'
          }
        }`)
      expect(outcomesOf(method)).toContain("'loaded'")
      const destructured = one(`
        type User = { role: string }
        function isAdmin(u: User): boolean {
          const { role } = u
          if (role === 'root') return true
          return role === 'admin'
        }
        // @vantle: "Q"
        export function f(user: User, promote: boolean): boolean {
          if (user.role === 'admin') return true
          if (promote) user.role = 'admin'
          return isAdmin(user)
        }`)
      expect(destructured.paths.some((p) => p.steps.some((s) => destructured.nodes.find((n) => n.id === s.node)?.rawLabel === "user.role === 'admin'" && s.edge === 'yes') && p.steps.filter((s) => destructured.nodes.find((n) => n.id === s.node)?.rawLabel === "user.role === 'admin'").length === 2)).toBe(true)
    })
  })

  it("doesn't split the chart on logging into a nested object or on methods that change nothing", () => {
    const nested = one(`
      type Ctx = { user: { log: string[]; plan: string; admin: boolean } }
      // @vantle: "Q"
      export function decide(ctx: Ctx, a: boolean, b: boolean): string {
        if (a) ctx.user.log.push('a')
        if (b) ctx.user.log.push('b')
        if (ctx.user.admin) return 'admin'
        if (ctx.user.plan === 'pro') return 'pro'
        return 'free'
      }`)
    expect(nested.pathCount).toBe(3)
    const forEach = one(`
      // @vantle: "Q"
      export function check(items: { id: string }[], verbose: boolean, a: boolean): string {
        if (verbose) items.forEach((i) => console.log(i.id))
        if (items.length === 0) return 'empty'
        if (a) return 'a'
        return 'none'
      }`)
    expect(forEach.pathCount).toBe(3)
  })

  it('shows a reassigned parameter by its own name after the checks are drawn once', () => {
    const flow = one(`
      function h(n: number, dbl: boolean, p: boolean, q: boolean, r: boolean, s: boolean): boolean {
        if (dbl) n = n * 2
        if (p) return true
        if (q) return true
        if (r) return true
        if (s) return false
        if (n > 10) return true
        return false
      }
      // @vantle: "Q"
      export function f(x: number, dbl: boolean, p: boolean, q: boolean, r: boolean, s: boolean): boolean {
        return h(x, dbl, p, q, r, s)
      }`)
    expect(decisions(flow)).not.toContain('x > 10')
  })

  it('treats the same helper call in two places as one question', () => {
    const flow = one(`
      type O = { strict?: boolean }
      function isStrict(opts?: O): boolean {
        opts = { strict: false, ...opts }
        if (opts.strict) return true
        return false
      }
      // @vantle: "Q"
      export function f(a: O | undefined, x: boolean): string {
        if (x) { if (isStrict(a)) return 'xs' }
        if (isStrict(a)) return 'strict'
        return 'loose'
      }`)
    expect(flow.pathCount).toBe(4)
  })

  it('follows break to a label', () => {
    const flow = one(`
      // @vantle: "Q"
      export function f(xs: number[], x: number): string {
        outer: for (const e of xs) {
          switch (e) {
            case 1:
              if (x < 0) break outer
              break
          }
          if (x === 3) return 'three'
        }
        return 'none'
      }`)
    expect(decisions(flow)).toContain('x < 0')
  })

  it('fails loudly on an arrow to a missing box', () => {
    const graph: Graph = { root: 'a', nodes: new Map([['a', { id: 'a', kind: 'decision', branch: 'boolean', test: 'x', edges: [{ label: 'yes', to: 'gone' }, { label: 'no', to: 'gone' }] }]]) }
    expect(() => enumeratePaths(graph, 10)).toThrow(/isn't in it/)
  })
})

describe('path logic never rules out a route the code can take', () => {
  /** Every route through the chart, as `label=answer` steps (step boxes left out) and the outcome. */
  const routes = (flow: RawFlow) => {
    const label = new Map(flow.nodes.map((n) => [n.id, n.kind === 'outcome' ? n.value : n.rawLabel]))
    const kinds = new Map(flow.nodes.map((n) => [n.id, n.kind]))
    return enumeratePaths(toGraph(flow.root, flow.nodes, flow.edges), 1000).paths.map(
      (p) => `${p.steps.filter((s) => kinds.get(s.node) === 'decision').map((s) => `${label.get(s.node)}=${s.edge}`).join(' ')} -> ${label.get(p.outcome)}`,
    )
  }

  it('keeps whether a value is truthy apart from what it equals', () => {
    const flow = one(`
      // @vantle: "Q"
      export function check(x: string | null, y: boolean): string {
        if (x === 'a') {
          if (y) return 'ya'
        }
        if (x) return 'set'
        return 'unset'
      }`)
    expect(routes(flow)).toContain("x === 'a'=yes y=no x=yes -> 'set'")
  })

  it('lets a falsy check follow `=== null`', () => {
    const flow = one(`
      // @vantle: "Q"
      export function check(x: string | null, y: boolean): string {
        if (x === null) {
          if (y) return 'null-y'
        }
        if (!x) return 'empty'
        return 'set'
      }`)
    expect(routes(flow)).toContain("x === null=yes y=no x=no -> 'empty'")
  })

  it("doesn't let a helper's step box decide the caller's variable of the same name", () => {
    const flow = one(`
      function h(p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): boolean {
        let mode = 'a'
        if (p) mode = 'b'
        if (a) return true
        if (b) return true
        if (c) return true
        if (d) return true
        return mode === m
      }
      // @vantle: "Q"
      export function check(mode: string, p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): string {
        if (h(p, a, b, c, d, m)) return 'H'
        if (mode === 'a') return 'A'
        return 'other'
      }`)
    expect(flow.nodes.some((n) => n.kind === 'action')).toBe(true)
    // Whichever value the helper's step set, the caller's own mode can still be 'a'.
    const toA = routes(flow).filter((r) => r.endsWith("-> 'A'"))
    expect(toA.length).toBeGreaterThanOrEqual(2)
  })

  it("doesn't let a helper's own step box decide its check on the caller's value", () => {
    const flow = one(`
      function h(m: string, q: boolean, a: boolean, b: boolean, c: boolean, d: boolean): string {
        let mode = 'x'
        if (q) mode = 'y'
        if (a) return 'ha'
        if (b) return 'hb'
        if (c) return 'hc'
        if (d) return 'hd'
        if (m === 'a') return 'm-is-a'
        return mode
      }
      // @vantle: "Q"
      export function check(mode: string, q: boolean, a: boolean, b: boolean, c: boolean, d: boolean): string {
        return h(mode, q, a, b, c, d)
      }`)
    expect(routes(flow).some((r) => r.endsWith("-> 'm-is-a'"))).toBe(true)
  })

  it("doesn't let a same-named helper in another file decide the caller's variable", () => {
    const flow = extract(
      tempProject({
        'util.ts': `
          export function check(p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): boolean {
            let mode = 'a'
            if (p) mode = 'b'
            if (a) return true
            if (b) return true
            if (c) return true
            if (d) return true
            return mode === m
          }`,
        'main.ts': `
          import { check as h } from './util'
          // @vantle: "Q"
          export function check(mode: string, p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, m: string): string {
            if (h(p, a, b, c, d, m)) return 'H'
            if (mode === 'a') return 'A'
            return 'other'
          }`,
      }),
      'check',
    )
    expect(routes(flow).filter((r) => r.endsWith("-> 'A'")).length).toBeGreaterThanOrEqual(2)
  })

  it('still uses what a step box in the same function set, for its value and whether it is truthy', () => {
    const flow = one(`
      // @vantle: "Q"
      export function check(p: boolean, a: boolean, b: boolean, c: boolean, d: boolean): string {
        let mode = ''
        if (p) mode = 'b'
        if (a) return 'A'
        if (b) return 'B'
        if (c) return 'C'
        if (d) return 'D'
        if (mode) return 'set'
        return 'unset'
      }`)
    const steps = flow.nodes.filter((n) => n.kind === 'action').map((n) => n.rawLabel)
    expect(steps).toEqual(expect.arrayContaining(["mode = ''", "mode = 'b'"]))
    // After the step that set mode = '', the chart can't say mode is truthy.
    const label = new Map(flow.nodes.map((n) => [n.id, n.rawLabel]))
    const graph = toGraph(flow.root, flow.nodes, flow.edges)
    const set = enumeratePaths(graph, 1000).paths.filter((p) => p.steps.some((s) => label.get(s.node) === "mode = ''") && p.steps.some((s) => label.get(s.node) === 'mode' && s.edge === 'yes'))
    expect(set).toEqual([])
  })
})

describe('truthiness and value, linked only where a literal decides it', () => {
  const graph = (nodes: Graph['nodes'] extends Map<string, infer N> ? N[] : never, root: string): Graph => ({ root, nodes: new Map(nodes.map((n) => [n.id, n])) })

  it('compares charts that differ only in a falsy check before an equality as the same', () => {
    const expected = graph(
      [
        { id: 'q', kind: 'decision', branch: 'boolean', test: "x === 'a'", edges: [{ label: 'yes', to: 'A' }, { label: 'no', to: 'B' }] },
        { id: 'A', kind: 'outcome', value: "'A'", edges: [] },
        { id: 'B', kind: 'outcome', value: "'B'", edges: [] },
      ],
      'q',
    )
    const actual = graph(
      [
        { id: 'f', kind: 'decision', branch: 'boolean', test: 'x', edges: [{ label: 'yes', to: 'q' }, { label: 'no', to: 'B' }] },
        { id: 'q', kind: 'decision', branch: 'boolean', test: "x === 'a'", edges: [{ label: 'yes', to: 'A' }, { label: 'no', to: 'B' }] },
        { id: 'A', kind: 'outcome', value: "'A'", edges: [] },
        { id: 'B', kind: 'outcome', value: "'B'", edges: [] },
      ],
      'f',
    )
    const result = compareBehavior(expected, actual)
    expect(result.equivalent).toBe(true)
    expect(result.onlyInActual).toEqual([])
  })

  it('treats 0, -0 and 0.0 as one value', () => {
    const g = graph(
      [
        { id: 's', kind: 'action', assigns: [{ variable: 'x', value: '0' }], edges: [{ label: 'next', to: 'q' }] },
        { id: 'q', kind: 'decision', branch: 'boolean', test: 'x === -0', edges: [{ label: 'yes', to: 'A' }, { label: 'no', to: 'B' }] },
        { id: 'A', kind: 'outcome', value: "'A'", edges: [] },
        { id: 'B', kind: 'outcome', value: "'B'", edges: [] },
      ],
      's',
    )
    expect(enumeratePaths(g, 10).paths.map((p) => p.outcome)).toEqual(['A'])
  })

  it("doesn't take a step box after a check for how the check was answered", () => {
    const g = graph(
      [
        { id: 'x', kind: 'decision', branch: 'boolean', test: 'x', edges: [{ label: 'yes', to: 's' }, { label: 'no', to: 'z' }] },
        { id: 's', kind: 'action', assigns: [{ variable: 'x', value: "''" }], edges: [{ label: 'next', to: 'z' }] },
        { id: 'z', kind: 'decision', branch: 'boolean', test: 'z', edges: [{ label: 'yes', to: 'A' }, { label: 'no', to: 'B' }] },
        { id: 'A', kind: 'outcome', value: "'A'", edges: [] },
        { id: 'B', kind: 'outcome', value: "'B'", edges: [] },
      ],
      'x',
    )
    const path = enumeratePaths(g, 10).paths.find((p) => p.steps[0]!.edge === 'yes' && p.outcome === 'A')!
    const claim = { arrows: [{ node: 'x', edge: 'no' }, { node: 'z', edge: 'yes' }], reason: 'test' }
    expect(hasConflict(g, path, claim)).toBe(false)
  })
})

describe('catches that code Vantle cannot see can throw into', () => {
  const routes = (flow: RawFlow) => {
    const label = new Map(flow.nodes.map((n) => [n.id, n.kind === 'outcome' ? n.value : n.rawLabel]))
    const kinds = new Map(flow.nodes.map((n) => [n.id, n.kind]))
    return enumeratePaths(toGraph(flow.root, flow.nodes, flow.edges), 1000).paths.map(
      (p) => `${p.steps.filter((s) => kinds.get(s.node) === 'decision').map((s) => `${label.get(s.node)}=${s.edge}`).join(' ')} -> ${label.get(p.outcome)}`,
    )
  }

  it('looks through helpers for unseen calls, lists the catch, and keeps what the try checked out of it', () => {
    const flow = one(`
      function load(s: string): unknown {
        if (!s) throw new Error('missing')
        return JSON.parse(s)
      }
      // @vantle: "Q"
      export function check(s: string): string {
        try {
          load(s)
          return 'ok'
        } catch {
          if (s) return 'bad json'
          return 'missing'
        }
      }`)
    expect(flow.notCharted?.map((n) => n.kind)).toContain('catch')
    // JSON.parse throws with s set: the catch's own check can say yes.
    expect(routes(flow)).toContain("s=no s=yes -> 'bad json'")
  })

  it('keeps a step inside such a try from leaving an older fact in force after it', () => {
    const flow = one(`
      // @vantle: "Q"
      export function check(q: boolean, p: boolean, a: boolean, b: boolean, c: boolean, d: boolean, s: string): string {
        let mode = 'a'
        if (q) mode = 'c'
        if (a) return 'A'
        if (b) return 'B'
        try {
          if (p) mode = 'b'
          if (c) return 'C'
          if (d) return 'D'
          JSON.parse(s)
        } catch {
          return 'err'
        }
        if (mode === 'b') return 'modeB'
        return 'other'
      }`)
    expect(routes(flow).some((r) => r.endsWith("-> 'modeB'"))).toBe(true)
  })

  it('counts a helper whose catch can throw again as letting the throw out', () => {
    const flow = one(`
      function parse(s: string): unknown {
        try {
          return JSON.parse(s)
        } catch (e) {
          if (s.length > 3) throw e
          return null
        }
      }
      // @vantle: "Q"
      export function check(s: string): string {
        try {
          parse(s)
          return 'ok'
        } catch {
          return 'bad'
        }
      }`)
    expect(flow.notCharted?.map((n) => n.kind)).toContain('catch')
  })

  it('counts a catch that passes the error on through a helper as letting it out', () => {
    const flow = one(`
      function rethrow(e: unknown): never {
        throw e
      }
      function parse(s: string): unknown {
        try {
          return JSON.parse(s)
        } catch (e) {
          if (s.length > 3) rethrow(e)
          return null
        }
      }
      // @vantle: "Q"
      export function check(s: string): string {
        try {
          if (!s) throw new Error('missing')
          parse(s)
          return 'ok'
        } catch {
          if (s) return 'bad'
          return 'missing'
        }
      }`)
    expect(flow.notCharted?.filter((n) => n.kind === 'catch' && n.symbol === 'check').length).toBe(1)
    expect(routes(flow).some((r) => r.endsWith("-> 'bad'"))).toBe(true)
  })

  it("doesn't count logging, building an error, or a call an inner catch stops", () => {
    const flow = one(`
      function note(m: string) {
        console.log(m)
      }
      function fail(m: string): Error {
        const e = new Error(m)
        return e
      }
      // @vantle: "Q"
      export function check(s: string, a: boolean): string {
        try {
          note(s)
          try {
            JSON.parse(s)
          } catch {
            return 'inner'
          }
          if (a) throw fail('a')
          return 'ok'
        } catch {
          return 'outer'
        }
      }`)
    expect(flow.notCharted?.filter((n) => n.kind === 'catch')).toEqual([expect.objectContaining({ code: expect.stringContaining('catch') })])
    // Only the inner catch is listed (JSON.parse can throw into it); the outer one isn't.
    expect(flow.notCharted?.filter((n) => n.kind === 'catch').length).toBe(1)
  })

  it("doesn't count a helper whose own catch stops what it can't see", () => {
    const flow = one(`
      function parse(s: string): unknown {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      }
      function load(s: string): unknown {
        if (!s) throw new Error('missing')
        return parse(s)
      }
      // @vantle: "Q"
      export function check(s: string): string {
        try {
          load(s)
          return 'ok'
        } catch {
          if (s) return 'odd'
          return 'missing'
        }
      }`)
    expect(flow.notCharted?.filter((n) => n.kind === 'catch')).toEqual([])
    expect(routes(flow)).not.toContain("s=no s=yes -> 'odd'")
  })
})

describe('a check after a change is a new question', () => {
  const routes = (flow: RawFlow) => {
    const label = new Map(flow.nodes.map((n) => [n.id, n.kind === 'outcome' ? n.value : n.rawLabel]))
    const kinds = new Map(flow.nodes.map((n) => [n.id, n.kind]))
    return enumeratePaths(toGraph(flow.root, flow.nodes, flow.edges), 1000).paths.map(
      (p) => `${p.steps.filter((s) => kinds.get(s.node) === 'decision').map((s) => `${label.get(s.node)}=${s.edge}`).join(' ')} -> ${label.get(p.outcome)}`,
    )
  }
  const reaches = (flow: RawFlow, outcome: string) => routes(flow).some((r) => r.endsWith(`-> ${outcome}`))

  /** `check(u, b)` where `change` may set u.admin to false between two checks of it. */
  const revoke = (change: string, helpers = '', params = '') =>
    one(`
      export interface User { admin: boolean; name: string; ban(): { ok: boolean } }
      ${helpers}
      // @vantle: "Q"
      export function check(u: User, b: boolean${params}): string {
        if (u.admin) {
          if (b) { ${change} }
          if (u.admin) return 'still'
          return 'revoked'
        }
        return 'user'
      }`)

  it('through an alias', () => {
    expect(reaches(revoke('const a = u; a.admin = false'), "'revoked'")).toBe(true)
  })

  it('through another reference to the same object', () => {
    const flow = revoke('demote(holder.user)', 'function demote(x: User) { x.admin = false }', ', holder: { user: User }')
    expect(reaches(flow, "'revoked'")).toBe(true)
  })

  it('in an initializer, and in a condition', () => {
    expect(reaches(revoke('const r = demote(u)', 'function demote(x: User): number { x.admin = false; return 1 }'), "'revoked'")).toBe(true)
    expect(reaches(revoke('if (demote(u)) return "d"', 'function demote(x: User): boolean { x.admin = false; return false }'), "'revoked'")).toBe(true)
  })

  it('through a helper that changes a copy, or hands it to code Vantle can\'t see', () => {
    expect(reaches(revoke('demote(u)', 'function demote(x: User) { const y = x; y.admin = false }'), "'revoked'")).toBe(true)
    expect(reaches(revoke('pass(u, save)', 'function pass(x: User, f: (u: User) => void) { f(x) }', ', save: (u: User) => void'), "'revoked'")).toBe(true)
  })

  it('in a callback or closure', () => {
    expect(reaches(revoke('[1].forEach(() => { u.admin = false })'), "'revoked'")).toBe(true)
    expect(reaches(revoke('const off = () => { u.admin = false }; off()'), "'revoked'")).toBe(true)
  })

  it('through a getter', () => {
    const flow = one(`
      export class Account {
        flag = true
        get admin(): boolean { return this.flag }
      }
      // @vantle: "Q"
      export function check(u: Account, b: boolean): string {
        if (u.admin) {
          if (b) u.flag = false
          if (u.admin) return 'still'
          return 'revoked'
        }
        return 'user'
      }`)
    expect(reaches(flow, "'revoked'")).toBe(true)
  })

  it('for a lookup asked again after a call Vantle can\'t see', () => {
    const flow = one(`
      export interface Repo { isLocked(id: string): Promise<boolean> }
      // @vantle: "Q"
      export async function check(repo: Repo, lockEverything: () => Promise<void>, id: string, force: boolean): Promise<string> {
        if (await repo.isLocked(id)) return 'locked'
        if (force) await lockEverything()
        if (await repo.isLocked(id)) return 'now locked'
        return 'open'
      }`)
    expect(reaches(flow, "'now locked'")).toBe(true)
  })

  it('on a later pass of a loop, nested loops included', () => {
    const flow = one(`
      export interface Flag { a: boolean }
      // @vantle: "Q"
      export function check(x: Flag, items: string[][]): string {
        if (x.a) return 'pre'
        for (const row of items) {
          for (const it of row) {
            if (x.a) return 'second-pass'
          }
          x.a = true
        }
        return 'end'
      }`)
    expect(reaches(flow, "'second-pass'")).toBe(true)
  })

  it('after a call written in a statement with && or !, or handed the object inside a check', () => {
    const lookup = one(`
      export interface Repo { isLocked(id: string): boolean }
      // @vantle: "Q"
      export function check(repo: Repo, lockAll: () => void, id: string, force: boolean): string {
        if (repo.isLocked(id)) return 'locked'
        force && lockAll()
        if (repo.isLocked(id)) return 'now locked'
        return 'open'
      }`)
    expect(reaches(lookup, "'now locked'")).toBe(true)
    expect(reaches(revoke('const failed = !save(u)', '', ', save: (u: User) => boolean'), "'revoked'")).toBe(true)
    expect(reaches(revoke('if (b && cb(u)) {}', '', ', cb: (u: User) => boolean'), "'revoked'")).toBe(true)
  })

  it('through a function handed over by name, a reassignable hook, or an overriding method', () => {
    expect(reaches(revoke('[u].forEach(demote)', 'function demote(x: User) { x.admin = false }'), "'revoked'")).toBe(true)
    expect(reaches(revoke('hook(u)', 'let hook = (x: User) => {}\nexport function setHook(h: (x: User) => void) { hook = h }'), "'revoked'")).toBe(true)
    expect(
      reaches(
        revoke('svc.touch(u)', 'export class Base { touch(u: User) {} }\nexport class Real extends Base { touch(u: User) { u.admin = false } }', ', svc: Base'),
        "'revoked'",
      ),
    ).toBe(true)
  })

  it('through a module variable, a constructor, or a setter', () => {
    const flow = one(`
      let locked = false
      function lock() { locked = true }
      function isLocked(): boolean { return locked }
      // @vantle: "Q"
      export function check(b: boolean): string {
        if (isLocked()) return 'locked'
        if (b) lock()
        if (isLocked()) return 'now locked'
        return 'open'
      }`)
    expect(reaches(flow, "'now locked'")).toBe(true)
    expect(reaches(revoke('new Demoter(u)', 'class Demoter { constructor(u: User) { u.admin = false } }'), "'revoked'")).toBe(true)
    const setter = one(`
      export class Account {
        admin = true
        set demoted(v: boolean) { this.admin = !v }
      }
      // @vantle: "Q"
      export function check(u: Account, b: boolean): string {
        if (u.admin) {
          if (b) u.demoted = true
          if (u.admin) return 'still'
          return 'revoked'
        }
        return 'user'
      }`)
    expect(reaches(setter, "'revoked'")).toBe(true)
  })

  it('in a try whose catch checks again, or in a callback that returns early', () => {
    const tryCatch = one(`
      export interface User { admin: boolean }
      function demote(u: User, b: boolean): number { u.admin = false; if (b) throw new Error('x'); return 1 }
      // @vantle: "Q"
      export function check(u: User, b: boolean): string {
        if (!u.admin) return 'user'
        try {
          return String(demote(u, b))
        } catch {
          if (u.admin) return 'still'
          return 'revoked'
        }
      }`)
    expect(reaches(tryCatch, "'revoked'")).toBe(true)
    expect(reaches(revoke('[1, 2].forEach((x) => { if (x > 1) { u.admin = false; return } })'), "'revoked'")).toBe(true)
  })

  it("through the object a used call is made on, a module's object, or an inherited constructor", () => {
    expect(reaches(revoke('if (u.ban().ok) {}', '', ''), "'revoked'")).toBe(true)
    const state = one(`
      const state = { locked: false }
      function lock() { state.locked = true }
      // @vantle: "Q"
      export function check(b: boolean): string {
        if (state.locked) return 'locked'
        if (b) lock()
        if (state.locked) return 'now locked'
        return 'open'
      }`)
    expect(reaches(state, "'now locked'")).toBe(true)
    expect(reaches(revoke('new D2(u)', 'class Demoter { constructor(u: User) { u.admin = false } }\nclass D2 extends Demoter {}'), "'revoked'")).toBe(true)
  })

  it("doesn't split a check over pure built-ins, a list of strings handed on, or reading a date", () => {
    const flow = one(`
      export interface User { name: string; tags: string[]; at: Date }
      // @vantle: "Q"
      export function check(u: User, send: (tags: string[]) => void, track: (s: string) => void): string {
        if (u.name.startsWith('a') && Array.isArray(u.name.split(''))) {
          track('hi')
          send(u.tags)
          const t = u.at.getTime()
          if (u.name.startsWith('a') && Array.isArray(u.name.split(''))) return 'same'
          return 'never'
        }
        return 'other'
      }`)
    expect(reaches(flow, "'never'")).toBe(false)
  })

  it('still treats a check as the same question when nothing that could change it happened', () => {
    // A different field, a primitive handed on, logging, a pure helper, and a fresh local object.
    const flow = revoke(
      'u.name = "x"; track(u.name); console.log(u); pure(u); const r = { admin: true }; r.admin = false',
      'function pure(x: User): boolean { return x.name.length > 2 }',
      ', track: (s: string) => void',
    )
    expect(reaches(flow, "'revoked'")).toBe(false)
  })

  it('walks a helper again when something it reads changed between two calls of it', () => {
    const flow = one(`
      export interface User { admin: boolean }
      function isAdmin(u: User): boolean { if (u.admin) return true; return false }
      // @vantle: "Q"
      export function check(u: User, b: boolean): string {
        if (!isAdmin(u)) return 'no'
        if (b) u.admin = false
        if (isAdmin(u)) return 'still'
        return 'revoked'
      }`)
    expect(reaches(flow, "'revoked'")).toBe(true)
  })
})

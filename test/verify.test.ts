import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from '../src/project.js'
import type { RawFlow } from '../src/schema/flow.js'
import { testContext } from '../src/verify/context.js'
import { toMarkdown } from '../src/render/mermaid.js'
import { coverageTargets } from '../src/verify/coverage.js'
import { arrows, selectPaths } from '../src/verify/select.js'
import { verifyFlow } from '../src/verify/verify.js'
import { testPrompt, type PathSpec, type TestAnswer, type TestRequest, type TestWriter } from '../src/verify/writer.js'
import { editFile, extract, FIXTURE, tempProject } from './helpers.js'

const EXPORT_SOURCE = `
type Plan = 'free' | 'pro' | 'team'

// @vantle: "Can this user export?"
export function canExport(plan: Plan, admin: boolean, overLimit: boolean): boolean {
  if (plan === 'free') return false
  if (overLimit) {
    if (admin) return true
    return false
  }
  return true
}
`

/** Works out arguments for canExport straight from a path's answers. */
function exportTest(spec: PathSpec, specifier: string): string {
  const args = { plan: "'pro'", admin: 'false', overLimit: 'false' }
  for (const s of spec.steps) {
    if (s.code === "plan === 'free'") args.plan = s.answer === 'yes' ? "'free'" : "'team'"
    if (s.code === 'admin') args.admin = String(s.answer === 'yes')
    if (s.code === 'overLimit') args.overLimit = String(s.answer === 'yes')
  }
  return [
    `import { canExport } from '${specifier}'`,
    `import { run } from '../vantle'`,
    '',
    `it('${spec.id}', () => {`,
    `  run(() => canExport(${args.plan}, ${args.admin}, ${args.overLimit}))`,
    '})',
  ].join('\n')
}

/** A fake writer: answers from a function and records each request. */
function fakeWriter(answer: (spec: PathSpec, request: TestRequest) => TestAnswer) {
  const requests: TestRequest[] = []
  const writer: TestWriter = async (request) => {
    requests.push(request)
    return { answers: request.paths.map((p) => answer(p, request)), inputTokens: 100, outputTokens: 200, costUsd: 0.01 }
  }
  return { writer, requests }
}

function setup(source = EXPORT_SOURCE) {
  const dir = tempProject({ 'main.ts': source })
  const flow = extract(dir)
  return { dir, flow, vp: loadProject(dir) }
}

describe('path selection', () => {
  it('covers every arrow of the Slack chart with far fewer paths than exist', () => {
    const flow = extract(FIXTURE)
    const chosen = selectPaths(flow)
    const covered = new Set(chosen.flatMap((p) => p.steps.map((s) => `${s.node}|${s.edge}`)))
    expect(covered.size).toBe(arrows(flow.edges).length)
    expect(chosen.length).toBeLessThanOrEqual(25)
    expect(flow.pathCount).toBeGreaterThan(1000)
  })
})

describe('verify', () => {
  it('verifies every path when the tests reach the expected outcomes', async () => {
    const { flow, vp } = setup()
    const { writer, requests } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }))
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.verification).toMatchObject({ arrowsVerified: 6, arrowsTotal: 6, counts: { verified: verified.paths.length, failed: 0 } })
    expect(verified.paths.every((p) => p.status === 'verified' && p.test)).toBe(true)
    expect(verified.verification!.costUsd).toBeCloseTo(0.01 * requests.length)
  })

  it('writes one batch first, then shows a working test to the rest', async () => {
    const { flow, vp } = setup()
    const { writer, requests } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }))
    const verified = await verifyFlow(vp, flow, writer, { batchSize: 1 })
    expect(verified.paths.every((p) => p.status === 'verified')).toBe(true)
    expect(requests[0]!.example).toBeUndefined()
    expect(requests.length).toBeGreaterThan(1)
    for (const r of requests.slice(1)) expect(r.example).toMatchObject({ followed: true, code: expect.stringContaining('run(() => canExport(') })
    expect(verified.verification!.spend!.paths).toMatchObject({ requests: requests.length, tests: verified.paths.length })
  })

  it('reuses saved tests, and catches code that changed under the chart', async () => {
    const { dir, flow, vp } = setup()
    const first = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }))
    await verifyFlow(vp, flow, first.writer)

    // Same chart, same code: saved tests run, nothing new is written.
    const second = fakeWriter(() => {
      throw new Error('should not be asked')
    })
    const again = await verifyFlow(vp, flow, second.writer)
    expect(second.requests).toHaveLength(0)
    expect(again.verification!.counts.verified).toBe(flow.paths.length > 0 ? again.paths.length : 0)

    // Someone changes the code but not the chart: the saved tests catch it.
    editFile(path.join(dir, 'src/main.ts'), (t) => t.replace('if (admin) return true', 'if (admin) return false'))
    const drifted = await verifyFlow(loadProject(dir), flow, undefined, { codeChanged: true })
    const failed = drifted.paths.filter((p) => p.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]!.note).toContain('The chart says the code returns true here, but it returned false')
    expect(drifted.verification!.codeChanged).toBe(true)
  })

  it('repairs a broken test once, sending the error back', async () => {
    const { flow, vp } = setup()
    let broke = false
    const { writer, requests } = fakeWriter((spec, r) => {
      if (!broke && !r.repairs?.length) {
        broke = true
        return { id: spec.id, kind: 'test', code: `it('${spec.id}', () => { throw new TypeError('cannot read plan') })` }
      }
      return { id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    const repair = requests.find((r) => r.repairs?.length)
    expect(repair?.repairs?.[0]?.error).toContain('cannot read plan')
    expect(verified.paths.every((p) => p.status === 'verified')).toBe(true)
  })

  it('marks a test that keeps breaking as unverified, not failed', async () => {
    const { flow, vp } = setup()
    const { writer } = fakeWriter((spec) => ({ id: spec.id, kind: 'test', code: `it('${spec.id}', () => { throw new TypeError('nope') })` }))
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'unverified')).toBe(true)
    expect(verified.paths[0]!.note).toContain('broke before reaching the function')
  })

  it('records impossible paths and covers their arrows with other paths', async () => {
    // isAdult(age) and age < 18 look independent in the chart but contradict each other.
    const { flow, vp } = setup(`
      function isAdult(age: number): boolean { return age >= 18 }
      // @vantle: "Allowed in?"
      export function allowed(age: number, vip: boolean): boolean {
        if (isAdult(age)) {
          if (vip) return true
        }
        if (age < 18) return true
        return false
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const adult = spec.steps.find((s) => s.code === 'isAdult(age)')!
      const age = adult.answer === 'yes' ? 20 : 10
      const minor = spec.steps.find((s) => s.code === 'age < 18')
      if (minor && (minor.answer === 'yes') !== age < 18) {
        return { id: spec.id, kind: 'impossible', reason: 'isAdult(age) is age >= 18.', conflict: [{ box: adult.box, answer: adult.answer }, { box: minor.box, answer: minor.answer }] }
      }
      const vip = spec.steps.find((s) => s.code === 'vip')?.answer === 'yes'
      return {
        id: spec.id,
        kind: 'test',
        code: `import { allowed } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => allowed(${age}, ${vip})) })`,
      }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.verification!.counts.untestable).toBeGreaterThan(0)
    expect(verified.verification!.arrowsVerified).toBe(verified.verification!.arrowsTotal)
    const manifest = JSON.parse(readFileSync(path.join(vp.root, '.vantle/tests', flow.flow.slug, 'manifest.json'), 'utf8'))
    const impossible = Object.values(manifest.entries as Record<string, { kind: string; conflict?: unknown[] }>).filter((e) => e.kind === 'impossible')
    expect(impossible[0]!.conflict).toHaveLength(2)

    // Running again reuses everything: same paths, no new tests.
    const again = fakeWriter(() => {
      throw new Error('should not be asked')
    })
    const rerun = await verifyFlow(vp, flow, again.writer)
    expect(again.requests).toHaveLength(0)
    expect(rerun.verification!.counts).toEqual(verified.verification!.counts)
    const idsBySignature = (f: typeof verified) => Object.fromEntries(f.paths.map((p) => [p.signature, p.id]))
    expect(idsBySignature(rerun)).toEqual(idsBySignature(verified))
    expect(rerun.verification!.arrowsVerified).toBe(rerun.verification!.arrowsTotal)

    // The claim was about the code as it was. After an edit, the writer is asked again.
    editFile(path.join(vp.root, 'src/main.ts'), (t) => t.replace('return age >= 18', 'return age >= 18 // adult'))
    const edited = fakeWriter((spec) => ({ id: spec.id, kind: 'impossible', reason: 'Still contradictory.', conflict: [] }))
    const after = await verifyFlow(loadProject(vp.root), flow, edited.writer)
    expect(edited.requests.length).toBeGreaterThan(0)
    expect(after.paths.find((p) => p.status === 'untestable')!.note).toBe("Couldn't build a test. The test writer said: Still contradictory.")
  })

  it('leaves paths unverified when there is no test writer and no saved test', async () => {
    const { flow, vp } = setup()
    const verified = await verifyFlow(vp, flow as RawFlow, undefined)
    expect(verified.paths.every((p) => p.status === 'unverified')).toBe(true)
    expect(verified.paths[0]!.note).toContain('credentials')
  })
})

describe('route checks', () => {
  it('sends a test that missed its path back with where the code went, then verifies the fix', async () => {
    const { flow, vp } = setup()
    let first = true
    const { writer, requests } = fakeWriter((spec, r) => {
      // The first test for the "free plan" path forgets to set the plan.
      if (first && spec.steps[0]!.answer === 'yes' && !r.repairs?.length) {
        first = false
        return { id: spec.id, kind: 'test', code: `import { canExport } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => canExport('pro', false, false)) })` }
      }
      return { id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    const repair = requests.find((q) => q.repairs?.length)
    expect(repair?.repairs?.[0]?.error).toContain("the code answered no but this path needs yes")
    expect(verified.paths.every((p) => p.status === 'verified')).toBe(true)
  })

  it('fails a path when the code skips a box the chart says comes next', async () => {
    // The extractor only follows the try block, so the chart is missing "invalid JSON → false".
    const { flow, vp } = setup(`
      // @vantle: "Valid?"
      export function valid(text: string, strict: boolean): boolean {
        try {
          JSON.parse(text)
        } catch {
          return false
        }
        if (strict) return text.length > 3
        return true
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const strict = spec.steps.find((s) => s.code === 'strict')!.answer === 'yes'
      // Plain text, not JSON, so the code takes the branch the chart doesn't have.
      return { id: spec.id, kind: 'test', code: `import { valid } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => valid('hello', ${strict})) })` }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'failed')).toBe(true)
    expect(verified.paths[0]!.note).toMatch(/checks `strict` next, but it never did/)
    // Those tests left the chart, so the code they ran doesn't count as checked.
    expect(verified.verification!.completeness!.reachedByPaths).toBe(0)
  })

  it('checks which return fired for outcomes that are objects', async () => {
    const source = `
      // @vantle: "Result?"
      export function result(on: boolean): { enrolled: boolean; reason: string } {
        if (on) return { enrolled: true, reason: 'on' }
        return { enrolled: false, reason: 'off' }
      }`
    const { dir, flow, vp } = setup(source)
    const { writer } = fakeWriter((spec, r) => {
      const on = spec.steps[0]!.answer === 'yes'
      return { id: spec.id, kind: 'test', code: `import { result } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => result(${on})) })` }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`)).toEqual(['verified ', 'verified '])

    // Someone moves the check without updating the chart: same answers, other return.
    editFile(path.join(dir, 'src/main.ts'), (t) =>
      t.replace("if (on) return { enrolled: true, reason: 'on' }\n        return { enrolled: false, reason: 'off' }", "if (on) { return { enrolled: false, reason: 'off' } }\n        return { enrolled: true, reason: 'on' }"),
    )
    const drifted = await verifyFlow(loadProject(dir), flow, undefined, { codeChanged: true })
    expect(drifted.paths.some((p) => p.status === 'failed')).toBe(true)
  })
})

describe('step boxes', () => {
  it('verifies paths that pass through step boxes', async () => {
    const dir = tempProject({
      'store.ts': `export function lookup(id: string): boolean { return id === 'known' }`,
      'main.ts': `
        import { lookup } from './store'
        // @vantle: "Which group?"
        export function group(sticky: boolean, a: boolean, b: boolean, c: boolean, d: boolean, id: string): string {
          let found = false
          if (sticky) found = lookup(id)
          if (a) return 'x'
          if (b) return 'x'
          if (c) return 'x'
          if (d) return 'x'
          if (found) return 'sticky'
          return 'normal'
        }`,
    })
    const flow = extract(dir)
    expect(flow.nodes.some((n) => n.kind === 'action')).toBe(true)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      const found = spec.steps.some((s) => s.code === 'found' && s.answer === 'yes')
      const args = [answer('sticky'), answer('a'), answer('b'), answer('c'), answer('d'), `'${found ? 'known' : 'other'}'`]
      return { id: spec.id, kind: 'test', code: `import { group } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => group(${args.join(', ')})) })` }
    })
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim()).filter((s) => s !== 'verified')).toEqual([])
    expect(verified.verification!.arrowsVerified).toBe(verified.verification!.arrowsTotal)
  })
})

describe('completeness', () => {
  /** Writes a test from a path's answers, or for a place to reach, using the given calls. */
  function writerFor(name: string, forPath: (spec: { steps: PathSpec['steps'] }) => string, forTarget: (goal: string) => string | { impossible: string }) {
    return fakeWriter((spec, r) => {
      const target = r.targets?.find((t) => t.id === spec.id)
      const call = target ? forTarget(target.goal) : forPath(spec)
      if (typeof call !== 'string') return { id: spec.id, kind: 'impossible', reason: call.impossible, conflict: [] }
      return { id: spec.id, kind: 'test', code: `import { ${name} } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => ${call}) })` }
    })
  }

  /** The fake writer answers per item; targets come in as paths with no steps. */
  function fakeWriter(answer: (spec: { id: string; steps: PathSpec['steps'] }, request: TestRequest) => TestAnswer) {
    const requests: TestRequest[] = []
    const writer: TestWriter = async (request) => {
      requests.push(request)
      const items = [...request.paths, ...(request.targets ?? []).map((t) => ({ id: t.id, steps: [] }))]
      return { answers: items.map((p) => answer(p, request)), inputTokens: 100, outputTokens: 200, costUsd: 0.01 }
    }
    return { writer, requests }
  }

  const VALID = `
      // @vantle: "Valid?"
      export function valid(text: string, strict: boolean): boolean {
        try {
          JSON.parse(text)
        } catch {
          return false
        }
        if (strict) return text.length > 3
        return true
      }`

  it('finds a branch the chart is missing, even when every path verifies', async () => {
    // The extractor only follows the try block. Path tests use valid JSON, so they all pass.
    const { flow, vp } = setup(VALID)
    const { writer, requests } = writerFor(
      'valid',
      (spec) => {
        const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer
        return `valid('${answer('text.length > 3') === 'no' ? '1' : '"a long string"'}', ${answer('strict') === 'yes'})`
      },
      () => `valid('not json', false)`,
    )
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'verified')).toBe(true)
    const c = verified.verification!.completeness!
    expect(c.gaps).toHaveLength(1)
    expect(c.gaps[0]).toMatchObject({ status: 'missing', kind: 'exit', code: 'return false', line: 7, symbol: 'valid' })
    expect(c.gaps[0]!.note).toMatch(/At the start, the chart says the code checks `strict` next, but it never did/)
    expect(requests.at(-1)!.targets?.[0]?.goal).toBe('run `return false`')
    const page = toMarkdown(verified)
    expect(page).toContain('## Code the chart may be missing')
    expect(page).toContain('| r01 ([test](../tests/valid/r01-')
    expect(page).toContain('❌ missing from chart')
    expect(page).toMatch(/Code reached: 2 of 3 returns, throws and branches ran in a test and stayed on the chart; 1 missing from the chart/)

    // Running again reuses the saved test for it.
    const again = writerFor('valid', () => {
      throw new Error('should not be asked')
    }, () => {
      throw new Error('should not be asked')
    })
    const rerun = await verifyFlow(vp, flow, again.writer)
    expect(again.requests).toHaveLength(0)
    expect(rerun.verification!.completeness!.gaps.map((g) => g.status)).toEqual(['missing'])
  })

  it('counts code the chart handles once a test reaches it', async () => {
    // The loop's branch only changes the count, which the chart shows as the returned value.
    const { flow, vp } = setup(`
      // @vantle: "Score?"
      export function score(values: number[], off: boolean): number {
        let big = 0
        for (const v of values) {
          if (v > 5) big++
        }
        if (off) return -1
        return big
      }`)
    expect(flow.nodes.some((n) => n.rawLabel === 'v > 5')).toBe(false)
    const { writer } = writerFor('score', (spec) => `score([], ${spec.steps[0]!.answer === 'yes'})`, () => `score([9], false)`)
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'verified')).toBe(true)
    expect(verified.verification!.completeness).toMatchObject({ reachedOnChart: 1, gaps: [] })
  })

  it('reports code the writer says no input can reach as untestable', async () => {
    const { flow, vp } = setup(`
      // @vantle: "Allowed?"
      export function allowed(age: number): boolean {
        if (age < 0) {
          if (age > 10) return true
          return false
        }
        return age >= 18
      }`)
    const { writer } = writerFor(
      'allowed',
      (spec) => `allowed(${spec.steps[0]!.answer === 'yes' ? -1 : spec.steps.at(-1)!.answer === 'yes' ? 20 : 10})`,
      () => ({ impossible: 'age can not be below 0 and above 10.' }),
    )
    const verified = await verifyFlow(vp, flow, writer)
    const gaps = verified.verification!.completeness!.gaps
    // The impossible arrow \`age > 10\` = yes leaves its return unreached too.
    expect(gaps.map((g) => `${g.status} ${g.code}`)).toEqual(['untestable return true'])
  })

  it('lists the places that matter in the charted functions', () => {
    const dir = tempProject({
      'main.ts': `
        function helper(x: number): boolean {
          if (x > 1) return true
          return false
        }
        // @vantle: "Ok?"
        export function ok(items: number[], debug: boolean, mode: string): boolean {
          let found = false
          let label = ''
          if (debug) console.log('debug')
          if (mode === 'a') label = 'x'
          for (const item of items) {
            if (item === 0) continue
            if (item > 5) found = true
          }
          switch (mode) {
            case 'b':
              break
            case 'c':
              found = true
              break
          }
          items.forEach((i) => {
            if (i) return
          })
          try {
            JSON.parse(mode)
          } catch {
            found = false
          }
          if (helper(items.length)) return found
          return false
        }`,
    })
    const flow = extract(dir)
    const targets = coverageTargets(loadProject(dir), flow)
    expect(targets.map((t) => `${t.fn} ${t.kind} ${t.code}`)).toEqual([
      'helper exit return true',
      'helper exit return false',
      "ok branch if (item === 0) → yes",
      'ok branch if (item > 5) → yes',
      "ok branch case 'c':",
      'ok catch catch',
      'ok exit return found',
      'ok exit return false',
    ])
  })
})

describe('failing closed', () => {
  const call = (name: string, args: string, r: TestRequest, id: string) =>
    `import { ${name} } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${id}', async () => { await run(() => ${name}(${args})) })`

  it("doesn't verify a test that never calls run(), or a file with two tests", async () => {
    const { flow, vp } = setup()
    let n = 0
    const { writer } = fakeWriter((spec, r) => {
      const code = n++ % 2 ? `it('${spec.id}', () => {})` : `${exportTest(spec, r.context.entry.specifier)}\nit('${spec.id} again', () => {})`
      return { id: spec.id, kind: 'test', code }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'unverified')).toBe(true)
    const notes = verified.paths.map((p) => p.note ?? '').join('\n')
    expect(notes).toContain("without calling the function through run()")
    expect(notes).toContain('exactly one test')
  })

  it('records what an awaited condition resolved to, not the promise', async () => {
    const dir = tempProject({
      'store.ts': `export async function allowed(id: string): Promise<boolean> { return id === 'ok' }`,
      'main.ts': `
        import { allowed } from './store'
        // @vantle: "Let in?"
        export async function letIn(id: string): Promise<string> {
          if (await allowed(id)) return 'in'
          return 'out'
        }`,
    })
    const flow = extract(dir)
    // Every test asks for an id that isn't allowed, so only the "no" path can verify.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('letIn', "'nope'", r, spec.id) }))
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    const byAnswer = Object.fromEntries(verified.paths.map((p) => [p.steps[0]!.edge, p.status]))
    expect(byAnswer).toEqual({ yes: 'unverified', no: 'verified' })
  })

  it("doesn't count a crash elsewhere as the chart's throw", async () => {
    const { flow, vp } = setup(`
      // @vantle: "Parse?"
      export function parse(strict: boolean, text: string): string {
        if (strict) {
          JSON.parse(text)
          throw new Error('strict mode')
        }
        return 'ok'
      }`)
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('parse', `${spec.steps[0]!.answer === 'yes'}, 'not json'`, r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const strict = verified.paths.find((p) => p.steps[0]!.edge === 'yes')!
    expect(strict.status).toBe('unverified')
    expect(strict.note).toMatch(/The code threw, but not the error from/)
  })

  it('moves probes only onto the same expression, and marks a box changed when that is unclear', async () => {
    const source = `
      // @vantle: "Level?"
      export function level(x: boolean, on: boolean): number {
        if (x) return 1
        if (on) return 2
        return 3
      }`
    const { dir, flow, vp } = setup(source)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      return { id: spec.id, kind: 'test', code: call('level', `${answer('x')}, ${answer('on')}`, r, spec.id) }
    })
    expect((await verifyFlow(vp, flow, writer)).paths.every((p) => p.status === 'verified')).toBe(true)

    // Lines added above shift every offset. Text search would put the probe for \`x\` into "export".
    const file = path.join(dir, 'src/main.ts')
    editFile(file, (t) => `// A comment that moves everything down.\nexport const extra = 1\n${t}`)
    const moved = await verifyFlow(loadProject(dir), flow, undefined, { codeChanged: true })
    expect(moved.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(moved.paths.map(() => 'verified'))

    // A second \`if (x)\` makes the box ambiguous, so it's reported as changed rather than guessed.
    editFile(file, (t) => t.replace('if (on) return 2', 'if (on) return 2\n        if (x) return 4'))
    const ambiguous = await verifyFlow(loadProject(dir), flow, undefined, { codeChanged: true })
    expect(ambiguous.paths.every((p) => p.status === 'unverified' && /changed, so the chart is out of date/.test(p.note ?? ''))).toBe(true)
    expect(ambiguous.verification!.outOfDate).toBe(true)
  })

  it('keeps each copy of a repeated expression on its own probe after an edit between them', async () => {
    const { dir, flow, vp } = setup(`
      function ok(a: number): boolean { return a > 1 }
      // @vantle: "Level?"
      export function level(a: number, b: boolean): number {
        if (b) {
          if (ok(a)) return 1
          return 2
        }
        if (ok(a)) return 3
        return 4
      }`)
    expect(flow.nodes.filter((n) => n.rawLabel === 'ok(a)')).toHaveLength(2)
    const { writer } = fakeWriter((spec, r) => {
      const b = spec.steps[0]!.answer === 'yes'
      const a = spec.steps[1]!.answer === 'yes' ? 5 : 0
      return { id: spec.id, kind: 'test', code: call('level', `${a}, ${b}`, r, spec.id) }
    })
    expect((await verifyFlow(vp, flow, writer)).paths.every((p) => p.status === 'verified')).toBe(true)
    // A line between the two copies moves only the second one.
    editFile(path.join(dir, 'src/main.ts'), (t) => t.replace('          return 2\n', '          const two = 2\n          return two\n'))
    const moved = await verifyFlow(loadProject(dir), flow, undefined, { codeChanged: true })
    expect(moved.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(moved.paths.map(() => 'verified'))
  })

  it('instruments a project opened through a symlink', async () => {
    const { dir } = setup()
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'vantle-link-')), 'project')
    symlinkSync(dir, link)
    const flow = extract(link)
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: exportTest(spec, r.context.entry.specifier) }))
    const verified = await verifyFlow(loadProject(link), flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(verified.paths.map(() => 'verified'))
  })

  it("blames a mocked charted helper, not the chart", async () => {
    const dir = tempProject({
      'roles.ts': `
        export function isAdmin(role: string): boolean {
          if (role === 'admin') return true
          return role === 'owner'
        }`,
      'main.ts': `
        import { isAdmin } from './roles'
        // @vantle: "Access?"
        export function access(role: string): string {
          if (isAdmin(role)) return 'all'
          return 'none'
        }`,
    })
    const flow = extract(dir)
    expect(flow.nodes.some((n) => n.rawLabel === "role === 'admin'")).toBe(true)
    const { writer } = fakeWriter((spec, r) => {
      const roles = r.context.importPaths.find((i) => i.file === 'src/roles.ts')!.specifier
      return { id: spec.id, kind: 'test', code: `vi.mock('${roles}', () => ({ isAdmin: () => true }))\n${call('access', "'guest'", r, spec.id)}` }
    })
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    expect(verified.paths.some((p) => p.status === 'failed')).toBe(false)
    expect(verified.paths.every((p) => p.status === 'unverified' && /mocked/.test(p.note ?? ''))).toBe(true)
  })

  it("doesn't verify a returned await when the code returned something else", async () => {
    const dir = tempProject({
      // It throws through JSON.parse, which Vantle can't see into, so the chart still says it returns.
      'store.ts': `export async function load(id: string): Promise<{ id: string }> { return JSON.parse(id) }`,
      'main.ts': `
        import { load } from './store'
        // @vantle: "Which user?"
        export async function user(id: string, cached: boolean): Promise<{ id: string } | null> {
          if (cached) return { id: 'cache' }
          try {
            return await load(id)
          } catch {
            return null
          }
        }`,
    })
    const flow = extract(dir)
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('user', `'x', ${spec.steps[0]!.answer === 'yes'}`, r, spec.id) }))
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    const byAnswer = Object.fromEntries(verified.paths.map((p) => [p.steps[0]!.edge, p]))
    expect(byAnswer.yes!.status).toBe('verified')
    expect(byAnswer.no!.status).toBe('unverified')
    expect(byAnswer.no!.note).toMatch(/didn't come from a return the chart knows about/)
  })

  it("doesn't count a different error as the chart's throw", async () => {
    const { flow, vp } = setup(`
      // @vantle: "Check?"
      export function check(user?: string): string {
        if (!user) {
          JSON.parse('{')
          throw new Error('no user')
        }
        return 'ok'
      }`)
    // The box is \`user\`: "no" is the path that throws. On it, a SyntaxError comes first.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('check', spec.steps.find((st) => st.code === 'user')?.answer === 'no' ? "''" : "'ann'", r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const thrown = verified.paths.find((p) => flow.nodes.find((n) => n.id === p.outcome)?.kind === 'outcome' && /no user/.test((flow.nodes.find((n) => n.id === p.outcome) as { value?: string }).value ?? ''))!
    expect(`${thrown.status} ${thrown.note}`).toMatch(/^unverified The code threw, but not the error from/)
  })

  it('treats a promise reaching a box as an unknown answer', async () => {
    const dir = tempProject({
      'remote.ts': `export async function remote(u: string): Promise<boolean> { return u === 'ok' }`,
      'main.ts': `
        import { remote } from './remote'
        async function allowed(u: string): Promise<boolean> {
          if (u === 'root') return true
          return remote(u)
        }
        // @vantle: "Let in?"
        export async function letIn(u: string): Promise<string> {
          if (await allowed(u)) return 'in'
          return 'out'
        }`,
    })
    const flow = extract(dir)
    const remoteBox = flow.nodes.find((n) => n.rawLabel === 'remote(u)')
    expect(remoteBox).toBeDefined()
    const { writer } = fakeWriter((spec, r) => {
      const root = spec.steps[0]!.answer === 'yes'
      const ok = spec.steps[1]?.answer === 'yes'
      return { id: spec.id, kind: 'test', code: call('letIn', root ? "'root'" : ok ? "'ok'" : "'guest'", r, spec.id) }
    })
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    const viaRemote = verified.paths.filter((p) => p.steps.some((s) => s.node === remoteBox!.id))
    expect(viaRemote.length).toBeGreaterThan(0)
    for (const p of viaRemote) expect(`${p.status} ${p.note}`).toMatch(/^unverified .*was a promise when the code checked it/)
  })

  it('reports a test that never runs the function as broken, not the chart', async () => {
    const { flow, vp } = setup(`${EXPORT_SOURCE}\nexport function other(): boolean { return true }\n`)
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: `import { other } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => other()) })` }))
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.every((p) => p.status === 'unverified' && /never ran `canExport`/.test(p.note ?? ''))).toBe(true)
  })

  it("doesn't call a saved test failed when it never followed its path", async () => {
    const { flow, vp } = setup()
    // Every test asks for a pro plan, so the "free plan" path's test always misses.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('canExport', "'pro', false, false", r, spec.id) }))
    await verifyFlow(vp, flow, writer)
    const again = await verifyFlow(vp, flow, undefined)
    expect(again.paths.some((p) => p.status === 'failed')).toBe(false)
  })

  it('blames a partial mock of a charted helper, not the chart', async () => {
    const dir = tempProject({
      'roles.ts': `
        export function isAdmin(role: string): boolean {
          if (role === 'admin') return true
          return role === 'owner'
        }
        export const other = 1`,
      'main.ts': `
        import { isAdmin } from './roles'
        // @vantle: "Access?"
        export function access(role: string): string {
          if (isAdmin(role)) return 'all'
          return 'none'
        }`,
    })
    const flow = extract(dir)
    const { writer } = fakeWriter((spec, r) => {
      const roles = r.context.importPaths.find((i) => i.file === 'src/roles.ts')!.specifier
      const mock = `vi.mock(import('${roles}'), async (orig) => ({ ...(await orig()), isAdmin: () => true }))`
      return { id: spec.id, kind: 'test', code: `${mock}\n${call('access', "'guest'", r, spec.id)}` }
    })
    const verified = await verifyFlow(loadProject(dir), flow, writer)
    expect(verified.paths.some((p) => p.status === 'failed')).toBe(false)
    expect(verified.paths.some((p) => /never entered `isAdmin`/.test(p.note ?? ''))).toBe(true)
  })

  it('handles files that start with a byte-order mark', async () => {
    const { flow, vp } = setup(`\uFEFF
      // @vantle: "Level?"
      export function level(x: boolean, on: boolean): number {
        const copy = x
        if (x) return copy ? 1 : 0
        if (on) return 2
        return 3
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      return { id: spec.id, kind: 'test', code: call('level', `${answer('x')}, ${answer('on')}`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(verified.paths.map(() => 'verified'))
  })

  it("doesn't move a probe into another function", async () => {
    const { dir, flow, vp } = setup(`
      type U = { admin: boolean; beta: boolean }
      // @vantle: "Access?"
      export function access(u: U): string {
        if (u.admin) return 'all'
        return 'none'
      }`)
    editFile(path.join(dir, 'src/main.ts'), (t) =>
      t.replace('if (u.admin) return', 'audit(u)\n        if (u.beta) return').replace('// @vantle', 'function audit(u: U): boolean { return !!u.admin }\n      // @vantle'),
    )
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('access', '{ admin: true, beta: true }', r, spec.id) }))
    const verified = await verifyFlow(loadProject(dir), flow, writer, { codeChanged: true })
    expect(verified.verification!.outOfDate).toBe(true)
    expect(verified.paths.some((p) => p.status === 'verified')).toBe(false)
  })

  it('explains an arrow that only claimed-impossible answers reach', async () => {
    // isAdult(age) and age < 18 can't both hold; once the writer says so, the arrow \`vip\` = yes on
    // the adult branch is only on paths that need both.
    const { flow, vp } = setup(`
      function isAdult(age: number): boolean { return age >= 18 }
      // @vantle: "Allowed in?"
      export function allowed(age: number, vip: boolean): boolean {
        if (isAdult(age)) {
          if (age < 18) {
            if (vip) return true
            return false
          }
          return true
        }
        return false
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const adult = spec.steps.find((s) => s.code === 'isAdult(age)')!
      const minor = spec.steps.find((s) => s.code === 'age < 18')
      if (adult.answer === 'yes' && minor?.answer === 'yes') {
        return { id: spec.id, kind: 'impossible', reason: 'An adult is never under 18.', conflict: [{ box: adult.box, answer: 'yes' }, { box: minor.box, answer: 'yes' }] }
      }
      return { id: spec.id, kind: 'test', code: call('allowed', `${adult.answer === 'yes' ? 30 : 10}, false`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    const v = verified.verification!
    // Every arrow is either on a tested path or on a path listed with the claim.
    const listed = new Set(verified.paths.flatMap((p) => p.steps.map((s) => `${s.node}|${s.edge}`)))
    expect(listed.size).toBe(v.arrowsTotal)
    expect(verified.paths.filter((p) => p.status === 'untestable').length).toBeGreaterThanOrEqual(2)
  })

  it("drops a claim when any test run gave the conflicting answers, even one that missed its path", async () => {
    const { flow, vp } = setup(`
      // @vantle: "Level?"
      export function level(a: boolean, b: boolean, c: boolean): number {
        if (!a) return 0
        if (!b) return 1
        if (c) return 2
        return 3
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer
      const [a, b, c] = [answer('!a') === 'no', answer('!b') === 'no', answer('c')]
      if (a && b && c === 'yes') {
        return { id: spec.id, kind: 'impossible', reason: 'a and b never both hold.', conflict: spec.steps.slice(0, 2).map((s) => ({ box: s.box, answer: s.answer })) }
      }
      // The test for c = no wrongly sets c, so it misses its path, but its run still has a and b.
      return { id: spec.id, kind: 'test', code: call('level', `${a}, ${b}, ${a && b ? true : false}`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.verification!.counts.untestable).toBe(0)
  })

  it("drops a writer's claim that a path can't happen once a verified test gives the same answers", async () => {
    const { flow, vp } = setup(`
      // @vantle: "Allowed in?"
      export function allowed(age: number, vip: boolean): boolean {
        if (vip) return true
        if (age < 18) return false
        return true
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const vip = spec.steps[0]!
      const minor = spec.steps.find((s) => s.code === 'age < 18')
      // A wrong claim: "not VIP" can happen, and another path's test shows it.
      if (minor?.answer === 'no') return { id: spec.id, kind: 'impossible', reason: 'Everyone is a VIP.', conflict: [{ box: vip.box, answer: 'no' }] }
      return { id: spec.id, kind: 'test', code: call('allowed', `${minor ? 10 : 30}, ${vip.answer === 'yes'}`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.verification!.counts.untestable).toBe(0)
    expect(verified.paths.find((p) => p.status === 'unverified')!.note).toMatch(/a test run gave those same answers/)
  })
})

describe('extraction fixes, end to end', () => {
  it('verifies the paths of a switch over enum members', async () => {
    const { flow, vp } = setup(`
      export enum Status { Active = 'active', Paused = 'paused' }
      // @vantle: "Label?"
      export function label(s: Status): string {
        switch (s) {
          case Status.Active:
            return 'on'
          case Status.Paused:
            return 'off'
        }
      }`)
    const { writer } = fakeWriter((spec, r) => ({
      id: spec.id,
      kind: 'test',
      code: `import { label, Status } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${spec.id}', () => { run(() => label(${spec.steps[0]!.answer})) })`,
    }))
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(['verified', 'verified'])
  })
})

describe('answers tied to the call they came from', () => {
  const call = (name: string, args: string, r: TestRequest, id: string) =>
    `import { ${name} } from '${r.context.entry.specifier}'\nimport { run } from '../vantle'\nit('${id}', async () => { await run(() => ${name}(${args})) })`
  const HELPER = `
    function h(x: boolean) {
      let result
      if (x) result = 'yes'
      else result = 'no'
      return { value: result }
    }
    // @vantle: "Which?"
    export function f(x: boolean) {
      h(true)
      return h(x)
    }`

  it("doesn't take a box's answer or the return from a call of the helper the chart doesn't draw", async () => {
    const { flow, vp } = setup(HELPER)
    // Every test runs f(false): the drawn call answers no, the earlier one yes.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('f', 'false', r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const byAnswer = Object.fromEntries(verified.paths.map((p) => [p.steps[0]!.edge, p.status]))
    expect(byAnswer).toEqual({ yes: 'unverified', no: 'verified' })
  })

  it("doesn't count code reached only by a call the chart doesn't draw", async () => {
    const { flow, vp } = setup(HELPER)
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('f', 'false', r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const c = verified.verification!.completeness!
    // The yes branch only ran in h(true), so a test is needed to reach it through h(x).
    expect(c.reachedByPaths).toBeLessThan(c.places)
  })

  it('takes answers from either call when two calls share the same boxes', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function allowed(u: U): boolean {
        if (u.admin) return true
        return u.owner
      }
      // @vantle: "Allowed?"
      export function ok(u: U, x: boolean): string {
        if (x) {
          if (allowed(u)) return 'yes'
        } else {
          if (allowed(u)) return 'yes'
        }
        return 'no'
      }`)
    const admin = flow.nodes.find((n) => n.kind === 'decision' && n.rawLabel === 'u.admin')
    expect(admin?.kind === 'decision' && admin.via?.length).toBe(2)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      return { id: spec.id, kind: 'test', code: call('ok', `{ admin: ${answer('u.admin')}, owner: ${answer('u.owner')} }, ${answer('x')}`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer, { allPaths: true })
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(verified.paths.map(() => 'verified'))
  })

  /** A writer that sets each box's answer from a table of box code → argument expressions. */
  const honest = (name: string, args: (answer: (code: string) => boolean) => string) =>
    fakeWriter((spec, r) => {
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      return { id: spec.id, kind: 'test', code: call(name, args(answer), r, spec.id) }
    })
  const allVerified = (f: { paths: { status: string; note?: string }[] }) =>
    expect(f.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(f.paths.map(() => 'verified'))

  it('ties answers in arrow functions with expression bodies', async () => {
    const helper = setup(`
      type U = { admin: boolean; owner: boolean }
      const allowed = (u: U): boolean => (u.admin ? true : u.owner)
      // @vantle: "Allowed?"
      export function ok(u: U): string {
        if (allowed(u)) return 'yes'
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin')}, owner: ${a('u.owner')} }`)
    allVerified(await verifyFlow(helper.vp, helper.flow, writer))
    const entry = setup(`
      // @vantle: "Pick?"
      export const pick = (a: boolean, b: boolean): string => (a ? 'A' : b ? 'B' : 'C')`)
    const second = honest('pick', (x) => `${x('a')}, ${x('b')}`)
    allVerified(await verifyFlow(entry.vp, entry.flow, second.writer))
  })

  it('ties answers in a helper whose name another function in the file also uses', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function other(x: number) {
        function allowed(y: number) { return y > 1 }
        return allowed(x)
      }
      function allowed(u: U): boolean {
        if (u.admin) return true
        return u.owner
      }
      // @vantle: "Allowed?"
      export function ok(u: U): string {
        other(1)
        if (allowed(u)) return 'yes'
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin')}, owner: ${a('u.owner')} }`)
    allVerified(await verifyFlow(vp, flow, writer))
  })

  it("doesn't let a call inside the arguments take the call's mark", async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner?: boolean }
      function allowed(u: U, tag?: string): boolean {
        if (u.admin) return true
        return !!u.owner
      }
      // @vantle: "Allowed?"
      export function ok(a: U, b: U): string {
        if (allowed(a, String(allowed(b)))) return 'yes'
        return 'no'
      }`)
    // Every test: a isn't an admin but owns it; b is an admin.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('ok', '{ admin: false, owner: true }, { admin: true }', r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const adminYes = verified.paths.find((p) => p.steps[0]!.edge === 'yes')!
    expect(adminYes.status).not.toBe('verified')
  })

  it('keeps runs of an async helper apart when they interleave', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean; delay: number }
      const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
      async function allowed(u: U): Promise<boolean> {
        await tick(u.delay)
        if (u.admin) return true
        return u.owner
      }
      // @vantle: "Allowed?"
      export async function ok(a: U, c: U): Promise<string> {
        const warm = allowed(c)
        if (await allowed(a)) {
          await warm
          return 'yes'
        }
        return 'no'
      }`)
    // The undrawn call (c, an admin) finishes its check while the drawn one (a) is waiting.
    const { writer } = fakeWriter((spec, r) => ({ id: spec.id, kind: 'test', code: call('ok', '{ admin: false, owner: true, delay: 40 }, { admin: true, owner: false, delay: 1 }', r, spec.id) }))
    const verified = await verifyFlow(vp, flow, writer)
    const adminYes = verified.paths.find((p) => p.steps[0]!.edge === 'yes')!
    expect(adminYes.status).not.toBe('verified')
    expect(verified.paths.some((p) => p.status === 'verified')).toBe(true)
  })

  it('ties answers to the outer run when the entry function calls itself', async () => {
    const { flow, vp } = setup(`
      // @vantle: "Sign?"
      export function sign(n: number, again: boolean): string {
        if (again) sign(-n, false)
        if (n > 0) return 'pos'
        return 'neg'
      }`)
    const { writer } = honest('sign', (a) => `${a('n > 0') ? 1 : -1}, true`)
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.filter((p) => p.steps.some((s) => s.edge === 'yes' && flow.nodes.find((n) => n.id === s.node)?.rawLabel === 'again')).every((p) => p.status === 'verified')).toBe(true)
  })

  it('keeps routes through a reused helper that calls another helper', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function k(u: U): boolean {
        if (u.owner) return true
        return false
      }
      function h(u: U): boolean {
        if (u.admin) return true
        return k(u)
      }
      // @vantle: "Allowed?"
      export function ok(u: U, m: number): string {
        if (m === 1) {
          if (k(u)) return 'yes'
        } else if (m === 2) {
          if (h(u)) return 'yes'
        } else {
          if (h(u)) return 'yes'
        }
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin')}, owner: ${a('u.owner')} }, ${a('m === 1') ? 1 : a('m === 2') ? 2 : 3}`)
    allVerified(await verifyFlow(vp, flow, writer, { allPaths: true }))
  })

  it('still verifies a chart saved before boxes recorded their calls', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function pick(u: U, alt: U): U {
        if (u.admin) return u
        return alt
      }
      // @vantle: "Who?"
      export function who(u: U, alt: U): U {
        return pick(u, alt)
      }`)
    const old = { ...flow, nodes: flow.nodes.map((n) => (n.kind === 'decision' ? { ...n, via: undefined } : n)) }
    const { writer } = honest('who', (a) => `{ admin: ${a('u.admin')}, owner: false }, { admin: false, owner: true }`)
    const verified = await verifyFlow(vp, old as typeof flow, writer)
    allVerified(verified)
    expect(verified.verification!.completeness!.reachedByPaths).toBe(verified.verification!.completeness!.places)
  })

  it('keeps two calls of a helper apart', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function allowed(u: U): boolean {
        if (u.admin) return true
        return u.owner
      }
      // @vantle: "Who?"
      export function who(a: U, b: U): string {
        if (allowed(a)) return 'a'
        if (allowed(b)) return 'b'
        return 'none'
      }`)
    const { writer } = fakeWriter((spec, r) => {
      // Each box is a.admin, a.owner, b.admin or b.owner; set exactly what the path says.
      const answer = (code: string) => spec.steps.find((s) => s.code === code)?.answer === 'yes'
      const args = `{ admin: ${answer('a.admin')}, owner: ${answer('a.owner')} }, { admin: ${answer('b.admin')}, owner: ${answer('b.owner')} }`
      return { id: spec.id, kind: 'test', code: call('who', args, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer)
    expect(verified.paths.map((p) => `${p.status} ${p.note ?? ''}`.trim())).toEqual(verified.paths.map(() => 'verified'))
  })

  it('verifies paths through the checks of a helper called as a statement', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; banned: boolean }
      function assertNotBanned(u: U) {
        if (u.banned) throw new Error('banned')
      }
      // @vantle: "Allowed?"
      export function ok(u: U): string {
        assertNotBanned(u)
        if (u.admin) return 'yes'
        return 'no'
      }`)
    expect(flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === 'u.banned')).toBe(true)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin')}, banned: ${a('u.banned')} }`)
    const verified = await verifyFlow(vp, flow, writer, { allPaths: true })
    allVerified(verified)
    expect(verified.verification!.completeness!.reachedByPaths).toBe(verified.verification!.completeness!.places)
  })

  it("doesn't verify a path whose input throws in a helper the chart used to miss", async () => {
    // Review of extractor-fixes: \`outer\` throws through \`return inner(x) * 2\`; verify reported both paths verified.
    const { flow, vp } = setup(`
      function inner(x: number): number { if (x < 0) throw new Error('neg'); return x }
      function outer(x: number): number { return inner(x) * 2 }
      // @vantle: "Q"
      export function q(x: number, y: boolean): string {
        outer(x)
        if (y) return 'y'
        return 'n'
      }`)
    expect(flow.nodes.some((n) => n.kind === 'decision' && n.rawLabel === 'x < 0')).toBe(true)
    const { writer } = honest('q', (a) => `${a('x < 0') ? -1 : 1}, ${a('y')}`)
    allVerified(await verifyFlow(vp, flow, writer, { allPaths: true }))
  })

  it('verifies paths where a helper throws into a catch', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; banned: boolean }
      function assertNotBanned(u: U) {
        if (u.banned) throw new Error('banned')
      }
      // @vantle: "Allowed?"
      export function ok(u: U): string {
        try {
          assertNotBanned(u)
        } catch {
          return 'blocked'
        }
        if (u.admin) return 'yes'
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin')}, banned: ${a('u.banned')} }`)
    allVerified(await verifyFlow(vp, flow, writer, { allPaths: true }))
  })

  it('ties answers to a helper whose default parameter calls another charted helper', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function roleOf(u: U): string {
        if (u.admin) return 'admin'
        return 'user'
      }
      function allowed(u: U, role = roleOf(u)): boolean {
        if (role === 'admin') return true
        return u.owner
      }
      // @vantle: "Allowed?"
      export function ok(u: U, x: boolean): string {
        if (x) return roleOf(u)
        if (allowed(u)) return 'yes'
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('u.admin') || a("roleOf(u) === 'admin'")}, owner: ${a('u.owner')} }, ${a('x')}`)
    const verified = await verifyFlow(vp, flow, writer, { allPaths: true })
    allVerified(verified)
    expect(verified.verification!.completeness!.reachedByPaths).toBe(verified.verification!.completeness!.places)
  })

  it('ties answers in a helper with a directive, called with a spread argument', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      function allowed(u: U, tag?: string): boolean {
        'use strict'
        const us = [u]
        // The code under test uses the name Vantle would give the run.
        const __vantleRun = us.length
        void __vantleRun
        if (us[0]!.admin) return true
        return us[0]!.owner
      }
      // @vantle: "Allowed?"
      export function ok(u: U): string {
        if (allowed(...([u] as [U]))) return 'yes'
        return 'no'
      }`)
    const { writer } = honest('ok', (a) => `{ admin: ${a('us[0]!.admin')}, owner: ${a('us[0]!.owner')} }`)
    allVerified(await verifyFlow(vp, flow, writer, { allPaths: true }))
  })

  it('ties answers to a call with no arguments whose callee comes from a charted call', async () => {
    const { flow, vp } = setup(`
      type U = { admin: boolean; owner: boolean }
      class Policy {
        constructor(private u: U) {}
        allows(): boolean {
          if (this.u.admin) return true
          return this.u.owner
        }
      }
      function policy(u: U): Policy {
        if (u.owner) return new Policy(u)
        return new Policy({ ...u })
      }
      // @vantle: "Allowed?"
      export function ok(u: U, x: boolean): string | Policy {
        if (x) return policy(u)
        if (policy(u).allows()) return 'yes'
        return 'no'
      }`)
    const { writer } = fakeWriter((spec, r) => {
      const answer = (end: string) => spec.steps.some((s) => s.code.endsWith(end) && s.answer === 'yes')
      return { id: spec.id, kind: 'test', code: call('ok', `{ admin: ${answer('.admin')}, owner: ${answer('.owner')} }, ${answer('x')}`, r, spec.id) }
    })
    const verified = await verifyFlow(vp, flow, writer, { allPaths: true })
    expect(verified.paths.filter((p) => p.status === 'failed').map((p) => p.note)).toEqual([])
  })
})

describe('test writer prompt', () => {
  it('gives import paths, the helpers, every path, and the source including types', () => {
    const flow = extract(FIXTURE)
    const vp = loadProject(FIXTURE)
    const context = testContext(vp, flow)
    const paths = selectPaths(flow).slice(0, 2)
    const { shared, request } = testPrompt({
      flow,
      context,
      boxes: [],
      paths: paths.map((p, i) => ({ id: `p0${i + 1}`, signature: 'x', steps: p.steps.map((s) => ({ box: 'n1', code: s.node, answer: s.edge })), outcome: { box: 'o1', value: 'true' } })),
    })
    // Everything but the paths is shared by every request, so it can be cached.
    expect(shared).toContain("- src/stores/prefs.ts: '../../../src/stores/prefs'")
    expect(shared).toContain("Function under test: `shouldNotify` from '../../../src/notify'")
    expect(shared).toContain("Vantle helpers: '../vantle'")
    expect(shared).toContain('export interface Message')
    expect(shared).not.toContain('### p01')
    expect(request).toContain('### p01')
    expect(request).not.toContain('export interface Message')
  })
})

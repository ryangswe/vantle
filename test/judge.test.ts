import { describe, expect, it } from 'vitest'
import type { RawFlow } from '../src/schema/flow.js'
import { judgeRun } from '../src/verify/judge.js'
import { checkRoute, probeTable, type ProbeTable, type Trace } from '../src/verify/route.js'
import { extract, tempProject } from './helpers.js'

/** A chart, its probes, and helpers to write the trace a run would record. */
function chart(source: string) {
  const flow = extract(tempProject({ 'main.ts': source }))
  const table = probeTable(flow)
  const box = (label: string, nth = 0) => flow.nodes.filter((n) => n.kind === 'decision' && n.rawLabel === label)[nth]!
  const outcome = (value: string) => flow.nodes.find((n) => n.kind === 'outcome' && n.value === value)!
  const answer = (label: string, t: boolean | string | number, nth = 0): Trace['events'][number] => {
    const p = table.byNode.get(box(label, nth).id)![0]!
    return typeof t === 'boolean' ? { p, t, v: t } : { p, t: !!t, v: t }
  }
  return { flow, table, box, outcome, answer }
}

const judge = (flow: RawFlow, table: ProbeTable, events: Trace['events'], result: Trace['result']) => judgeRun(flow, table, { events, result, calls: 1 })

describe('judging a run against its chart', () => {
  it('passes a run the chart draws', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): string {
        if (a) return 'x'
        if (b) return 'y'
        return 'z'
      }`)
    const j = judge(c.flow, c.table, [c.answer('a', false), c.answer('b', true)], { value: 'y' })
    expect(j.verdict).toEqual({ kind: 'pass' })
    expect(j.route.map((s) => s.edge)).toEqual(['no', 'yes'])
  })

  it('fails a run that ends somewhere other than the chart says', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean): string {
        if (a) return 'x'
        return 'z'
      }`)
    const j = judge(c.flow, c.table, [c.answer('a', true)], { value: 'z' })
    expect(j.verdict).toMatchObject({ kind: 'fail', reason: 'leftChart' })
  })

  it('fails, instead of crashing, when the code takes an arrow the chart dropped', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): string {
        if (a) return 'x'
        if (b) return 'y'
        return 'z'
      }`)
    // As if a dead-arrow pass had wrongly removed b's yes arrow.
    const b = c.box('b')
    const flow = { ...c.flow, edges: c.flow.edges.filter((e) => !(e.from === b.id && e.label === 'yes')) }
    const j = judge(flow, c.table, [c.answer('a', false), c.answer('b', true)], { value: 'y' })
    expect(j.verdict).toMatchObject({ kind: 'fail', reason: 'leftChart' })
    expect(j.verdict.kind === 'fail' && j.verdict.note).toContain('no such arrow')
    // verify reports it as a failed path, not a crash.
    const path = c.flow.paths.find((p) => p.steps.some((s) => s.node === b.id && s.edge === 'yes'))!
    expect(checkRoute(flow, c.table, path, { events: [c.answer('a', false), c.answer('b', true)], result: { value: 'y' }, calls: 1 })).toMatchObject({ kind: 'failed' })
  })

  it('fails a switch value no case handles; verify reports it unverified, since a test may pass a value its type forbids', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(k: 'a' | 'b' | 'c'): number {
        switch (k) {
          case 'a': return 1
          case 'b': return 2
          case 'c': return 3
        }
      }`)
    const k = c.box('k')
    const flow = { ...c.flow, edges: c.flow.edges.filter((e) => !(e.from === k.id && e.label !== "'a'" && e.label !== "'b'")) }
    const events = [c.answer('k', 'c')]
    expect(judge(flow, c.table, events, { value: 3 }).verdict).toMatchObject({ kind: 'fail', reason: 'leftChart' })
    const path = c.flow.paths.find((p) => p.steps[0]!.edge === "'a'")!
    expect(checkRoute(flow, c.table, path, { events, result: { value: 3 }, calls: 1 })).toMatchObject({ kind: 'broken' })
  })

  it("fails a run the chart's own path logic rules out", () => {
    // The chart takes both \`a\` checks for one question, so a run that answers them differently is
    // one it says can't happen: the sign of two different values read as one.
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): string {
        if (a) {
          if (b) return 'x'
        }
        if (a) return 'y'
        return 'z'
      }`)
    const events = [c.answer('a', true, 0), c.answer('b', false), c.answer('a', false, 1)]
    const first = c.flow.nodes.find((n) => n.id === c.flow.root)!
    // \`answer\` picks boxes in node order; make sure the first answer is the root's.
    if (first.id !== c.box('a', 0).id) [events[0], events[2]] = [c.answer('a', true, 1), c.answer('a', false, 0)]
    const j = judge(c.flow, c.table, events, { value: 'z' })
    expect(j.verdict).toMatchObject({ kind: 'fail', reason: 'ruledOut' })
  })

  it("doesn't judge a run whose loop ran more than once", () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(xs: { bad: boolean }[]): string {
        for (const x of xs) {
          if (x.bad) return 'bad'
        }
        return 'ok'
      }`)
    const twice = judge(c.flow, c.table, [c.answer('x.bad', false), c.answer('x.bad', true)], { value: 'bad' })
    expect(twice.verdict).toMatchObject({ kind: 'unjudged', reason: 'loop' })
    const never = judge(c.flow, c.table, [], { value: 'ok' })
    expect(never.verdict).toMatchObject({ kind: 'unjudged', reason: 'loop' })
  })

  it('fails a charted throw that fired where the chart says the code goes on', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean, b: boolean): number {
        if (a) throw new Error('x')
        if (b) return 1
        return 2
      }`)
    const thrown = c.table.byNode.get(c.outcome("throw new Error('x')").id)![0]!
    const j = judge(c.flow, c.table, [c.answer('a', false)], { threw: true, message: 'x', probe: thrown })
    expect(j.verdict).toMatchObject({ kind: 'fail', reason: 'leftChart' })
  })

  it('passes a throw from a helper inlined twice, whose one throw statement is two outcomes', () => {
    const c = chart(`
      function need(v: number, what: string) {
        if (v < 0) throw new Error(what)
      }
      // @vantle: "Q"
      export function f(a: number, b: number): string {
        need(a, 'a')
        need(b, 'b')
        return 'ok'
      }`)
    const second = c.outcome("throw new Error('b')")
    const thrown = c.table.byNode.get(second.id)![0]!
    expect(c.table.byNode.get(c.outcome("throw new Error('a')").id)).toContain(thrown)
    const j = judge(c.flow, c.table, [c.answer('a < 0', false), c.answer('b < 0', true)], { threw: true, message: 'b', probe: thrown })
    expect(j.verdict).toEqual({ kind: 'pass' })
  })

  it("leaves a throw from a run the chart doesn't follow unjudged", () => {
    const c = chart(`
      function need(v: number) {
        if (v < 0) throw new Error('neg')
      }
      // @vantle: "Q"
      export function f(a: number, xs: number[]): string {
        need(a)
        xs.forEach(need)
        return 'ok'
      }`)
    const thrown = c.table.byNode.get(c.outcome("throw new Error('neg')").id)![0]!
    // Run 1 is the entry; run 2 is \`need\` called from forEach, which no charted call site made.
    const trace: Trace = {
      events: [{ ...c.answer('a < 0', false), i: 2 }],
      invocations: [
        { id: 1, fn: `src/main.ts#f` },
        { id: 2, fn: `src/main.ts#need`, site: c.table.byVia.get(c.box('a < 0').id)![0]![0], parent: 1 },
        { id: 3, fn: `src/main.ts#need` },
      ],
      result: { threw: true, message: 'neg', probe: thrown, probeRun: 3 },
      calls: 1,
    }
    expect(judgeRun(c.flow, c.table, trace).verdict).toMatchObject({ kind: 'unjudged', reason: 'throw' })
  })

  it('fails a run that returned before a loop the chart sends it into', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean, items: string[]): string {
        if (a) return 'early'
        for (const it of items) {
          if (it === 'x') return 'x'
        }
        return 'end'
      }`)
    // As if the chart's \`a\` yes arrow went into the loop.
    const a = c.box('a')
    const loopBox = c.box("it === 'x'")
    const flow = { ...c.flow, edges: c.flow.edges.map((e) => (e.from === a.id && e.label === 'yes' ? { ...e, to: loopBox.id } : e)) }
    const early = c.table.byNode.get(c.outcome("'early'").id)
    const result = { value: 'early', ...(early ? { probe: early[0]! } : {}) }
    expect(judge(flow, c.table, [c.answer('a', true)], result).verdict).toMatchObject({ kind: 'fail' })
  })

  it("doesn't hold a run that went into a listed catch to the chart's route", () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(a: boolean): string {
        if (a) return 'x'
        return 'y'
      }`)
    // A probe standing for "entered a catch the chart lists", and a return inside that catch.
    const listed = c.table.probes.length
    c.table.probes.push({ id: listed, kind: 'reach', span: { file: 'src/main.ts', start: 1000, end: 1000 } })
    const inCatch = c.table.probes.length
    c.table.probes.push({ id: inCatch, kind: 'return', span: { file: 'src/main.ts', start: 1010, end: 1020 } })
    const clause = { probe: listed, file: 'src/main.ts', start: 990, end: 1100 }
    const wrong = { events: [c.answer('a', true), { p: listed, reach: true }, { p: inCatch, r: true }], result: { value: 'caught', probe: inCatch }, calls: 1 }
    expect(judgeRun(c.flow, c.table, wrong, { listedCatches: [clause] }).verdict).toMatchObject({ kind: 'unjudged', reason: 'catch' })
    // A result that didn't come from the catch (the run went on past it) excuses nothing.
    const outside = c.table.probes.length
    c.table.probes.push({ id: outside, kind: 'return', span: { file: 'src/main.ts', start: 2000, end: 2010 } })
    const after = { ...wrong, events: [c.answer('a', true), { p: listed, reach: true }, { p: outside, r: true }], result: { value: 'caught', probe: outside } }
    expect(judgeRun(c.flow, c.table, after, { listedCatches: [clause] }).verdict).toMatchObject({ kind: 'fail' })
    // Without it, the same run fails.
    expect(judgeRun(c.flow, c.table, wrong).verdict).toMatchObject({ kind: 'fail' })
    // Going into the catch somewhere else (before the answer that differs) excuses nothing.
    const earlier = { ...wrong, events: [{ p: listed, reach: true }, c.answer('a', true)] }
    expect(judgeRun(c.flow, c.table, earlier, { listedCatches: [clause] }).verdict).toMatchObject({ kind: 'fail' })
  })

  it('matches `case undefined` and never matches NaN', () => {
    const c = chart(`
      // @vantle: "Q"
      export function q(k: string | undefined | null): number {
        switch (k) {
          case undefined: return 1
          case null: return 2
          default: return 3
        }
      }`)
    const k = c.box('k')
    const p = c.table.byNode.get(k.id)![0]!
    expect(judge(c.flow, c.table, [{ p, t: false, v: '__undefined' }], { value: 1 }).route[0]!.edge).toBe('undefined')
    expect(judge(c.flow, c.table, [{ p, t: false, v: Number.NaN }], { value: 3 }).route[0]!.edge).toBe('default')
  })
})

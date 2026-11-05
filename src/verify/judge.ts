import { contradiction, toGraph } from '../graph/paths.js'
import type { RawFlow } from '../schema/flow.js'
import { pathSignature } from './select.js'
import { callPaths, checkReach, entered, entryKey, followTrace, type ProbeTable, type Trace } from './route.js'

/**
 * One run of the charted function, judged against its chart. Used by the
 * correctness check, which runs small functions on many inputs: every run is
 * something the code really did, so the chart has to allow it.
 */
export type Verdict =
  | { kind: 'pass' }
  /**
   * leftChart: the code went somewhere the chart doesn't draw, or ended differently.
   * ruledOut: the chart's own path logic says the route the code took can't happen,
   * so its path list hides a real path.
   */
  | { kind: 'fail'; reason: 'leftChart' | 'ruledOut'; note: string }
  /**
   * Runs the chart isn't held to, or that can't be read:
   * loop: a charted loop didn't run exactly once (charts draw one pass);
   * throw: the code threw from somewhere the chart doesn't draw as a throw;
   * promise: a box got a promise, so its answer isn't known;
   * catch: the run went into a catch the chart lists as reachable from code it doesn't draw,
   *   and its route differs from the chart's;
   * unexpected: anything else, usually a harness or instrumentation problem.
   */
  | { kind: 'unjudged'; reason: 'loop' | 'throw' | 'promise' | 'catch' | 'unexpected'; note: string }

export interface Judged {
  verdict: Verdict
  /** The arrows the code took, as far as the chart could follow it. Real executions either way. */
  route: { node: string; edge: string }[]
  /** Boxes the code evaluated that the route never visits. Reported, not failed: a check the extractor settled shares its code with boxes drawn elsewhere. */
  offRoute: string[]
}

export interface JudgeOptions {
  /** Each catch the chart lists as reachable from code it doesn't draw: the reach probe at its start, and where it is. */
  listedCatches?: { probe: number; file: string; start: number; end: number }[]
}

export function judgeRun(flow: RawFlow, table: ProbeTable, trace: Trace, options: JudgeOptions = {}): Judged {
  const walk = followTrace(flow, table, trace)
  const route = walk.route
  const offRoute = evaluatedOffRoute(flow, table, trace, route)
  // A run that left the chart's route by going into a listed catch may have got there from
  // code the chart doesn't draw, so where it ended isn't held against it. That needs all of:
  // going into the catch was the next thing it did after the last answer the chart followed,
  // and its result came from a listed catch. A route the chart's own logic rules out is never excused.
  const listed = options.listedCatches ?? []
  const catches = new Set(listed.map((c) => c.probe))
  const next = trace.events.slice(walk.cursor).find((e) => catches.has(e.p) || (!e.r && !e.reach))
  // Where the run ended: the last return, throw or reach mark it passed (a return the chart
  // doesn't draw still has a completeness mark before it).
  const last = [...trace.events].reverse().find((e) => (e.r || e.reach) && ['return', 'reach'].includes(table.probes[e.p]?.kind ?? ''))
  const ended = last ? table.probes[last.p]?.span : undefined
  const fromCatch = !!ended && listed.some((c) => c.file === ended.file && ended.start >= c.start && ended.end <= c.end)
  const listedCatch = !!next && catches.has(next.p) && (fromCatch || !!trace.result?.threw)
  const out = (verdict: Verdict): Judged =>
    verdict.kind === 'fail' && verdict.reason !== 'ruledOut' && listedCatch
      ? { verdict: { kind: 'unjudged', reason: 'catch', note: `The run went into a catch the chart lists as not fully drawn. (${verdict.note})` }, route, offRoute }
      : { verdict, route, offRoute }

  if ((trace.calls ?? 1) !== 1) return out({ kind: 'unjudged', reason: 'unexpected', note: `The run called the function ${trace.calls} times.` })
  if (!entered(table, trace, entryKey(flow))) return out({ kind: 'unjudged', reason: 'unexpected', note: 'The run never entered the function.' })

  const loop = loopRunCount(flow, table, trace, walk.end)
  if (loop) return out({ kind: 'unjudged', reason: 'loop', note: loop })

  // A throw the chart draws, fired somewhere the chart's route doesn't reach it. A helper
  // inlined twice has one throw statement and two outcomes, so any of them will do. A throw
  // from a run the chart doesn't follow (the helper called from a callback) is like any
  // throw the chart doesn't draw.
  const result = trace.result
  const followed = result?.probeRun === undefined || !table.tied || !trace.invocations || callPaths(trace, entryKey(flow)).get(result.probeRun) !== undefined
  const throwOutcomes = result?.threw && result.probe !== undefined && followed ? chartedThrows(flow, table, result.probe) : []
  if (throwOutcomes.length && !(walk.end.kind === 'outcome' && throwOutcomes.includes(walk.end.node))) {
    const where = walk.end.kind === 'outcome' ? `the chart ends at \`${rawLabel(flow, walk.end.node)}\`` : `the chart expected \`${rawLabel(flow, walk.end.node)}\` next`
    return out({ kind: 'fail', reason: 'leftChart', note: `The code threw at \`${rawLabel(flow, throwOutcomes[0]!)}\`, but ${where}.` })
  }

  if (walk.end.kind === 'undecidable' && walk.end.value === '__promise') {
    return out({ kind: 'unjudged', reason: 'promise', note: `\`${rawLabel(flow, walk.end.node)}\` got a promise.` })
  }
  if (result?.threw && !throwOutcomes.length) {
    // Not yet tied to the listing that explains it: a throw from a helper shown as one box is listed at its call.
    const listed = (flow.notCharted ?? []).some((n) => /can throw/.test(n.note))
    const why = listed ? 'The chart lists a helper that can throw.' : "Nothing the chart lists explains it; it may come from code Vantle can't see."
    return out({ kind: 'unjudged', reason: 'throw', note: `The code threw from a place the chart doesn't draw as a throw (${result.message ?? ''}). ${why}` })
  }
  // A switch value no case handles: the inputs follow the types, so the chart is missing a case.
  if (walk.end.kind === 'offChart') {
    return out({ kind: 'fail', reason: 'leftChart', note: `At \`${rawLabel(flow, walk.end.node)}\`, the code answered ${walk.end.answer} (${JSON.stringify(walk.end.value)}), but the chart has no such arrow.` })
  }

  const end = checkReach(flow, table, trace, { key: '', code: '', kind: '' })
  if (end.kind === 'gap') return out({ kind: 'fail', reason: 'leftChart', note: end.note })
  if (end.kind === 'broken') return out({ kind: 'unjudged', reason: 'unexpected', note: end.note })

  const at = contradiction(toGraph(flow.root, flow.nodes, flow.edges), route)
  if (at !== undefined) {
    const s = route[at]!
    return out({ kind: 'fail', reason: 'ruledOut', note: `The code answered \`${rawLabel(flow, s.node)}\` ${s.edge}, which the chart's paths rule out after the answers before it.` })
  }
  if (!flow.pathsTruncated && walk.end.kind === 'outcome') {
    const signature = pathSignature({ steps: route, outcome: walk.end.node })
    if (!flow.paths.some((p) => pathSignature(p) === signature)) {
      return out({ kind: 'fail', reason: 'ruledOut', note: "The route the code took isn't among the chart's paths." })
    }
  }
  return out({ kind: 'pass' })
}

/** Why a run can't be held to a chart that draws its loops as one pass, if it can't. */
function loopRunCount(flow: RawFlow, table: ProbeTable, trace: Trace, end: ReturnType<typeof followTrace>['end']): string | undefined {
  const inLoop = new Map<number, string>()
  for (const n of flow.nodes) if (n.kind === 'decision' && n.loop) for (const p of table.byNode.get(n.id) ?? []) inLoop.set(p, n.id)
  if (!inLoop.size) return undefined
  const loopProbe = end.kind === 'skipped' ? (table.byNode.get(end.node) ?? [])[0] : undefined
  if (loopProbe !== undefined && inLoop.has(loopProbe)) {
    // The code ended at a return or throw written before the loop, in the same function: it never
    // got to the loop, so the chart sent it the wrong way. Judge that normally.
    const loop = table.probes[loopProbe]!.span
    const ended = trace.result?.probe !== undefined ? table.probes[trace.result.probe]?.span : undefined
    const before = ended && ended.file === loop.file && ended.owner === loop.owner && ended.start < loop.start
    // ...and in the same call: a helper drawn twice has one return statement for both calls.
    const ran = trace.result?.probeRun
    const routes = table.byVia.get(end.node)
    let sameCall = true
    if (table.tied && trace.invocations && ran !== undefined && routes) {
      const path = callPaths(trace, entryKey(flow)).get(ran)
      sameCall = !!path && routes.some((r) => r.join('>') === path.join('>'))
    }
    if (!before || !sameCall) return `The loop around \`${rawLabel(flow, end.node)}\` didn't run.`
  }
  const seen = new Map<string, number>()
  for (const e of trace.events) {
    if (e.r || e.reach || !inLoop.has(e.p)) continue
    const key = `${e.p}@${e.i ?? ''}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > 1) return `The loop around \`${rawLabel(flow, inLoop.get(e.p)!)}\` ran more than once.`
  }
  return undefined
}

/** The charted throws whose throw statement `probe` is. */
function chartedThrows(flow: RawFlow, table: ProbeTable, probe: number): string[] {
  return flow.nodes.filter((n) => n.kind === 'outcome' && n.value.startsWith('throw ') && (table.byNode.get(n.id) ?? []).includes(probe)).map((n) => n.id)
}

function evaluatedOffRoute(flow: RawFlow, table: ProbeTable, trace: Trace, route: { node: string }[]): string[] {
  const owners = new Map<number, string[]>()
  for (const [node, probes] of table.byNode) for (const p of probes) owners.set(p, [...(owners.get(p) ?? []), node])
  const visited = new Set(route.flatMap((s) => table.byNode.get(s.node) ?? []))
  const charted = table.tied ? callPaths(trace, entryKey(flow)) : undefined
  const decisions = new Set(flow.nodes.filter((n) => n.kind === 'decision' && !n.loop).map((n) => n.id))
  const out = new Set<string>()
  for (const e of trace.events) {
    if (e.r || e.reach || visited.has(e.p)) continue
    if (charted && (e.i === undefined || charted.get(e.i) === undefined)) continue
    const nodes = owners.get(e.p) ?? []
    // A probe shared by several boxes (a helper drawn twice) can't say which one ran.
    if (nodes.length === 1 && decisions.has(nodes[0]!)) out.add(nodes[0]!)
  }
  return [...out]
}

function rawLabel(flow: RawFlow, id: string): string {
  const n = flow.nodes.find((x) => x.id === id)
  return n && 'rawLabel' in n ? n.rawLabel : id
}

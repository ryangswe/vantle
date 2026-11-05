import { expressionRanges, occurrences, type Ranges } from '../spans.js'
import type { FlowPath, Span } from '../schema/flow.js'
import type { AnyFlow } from '../schema/labeled.js'
import { normalizeCode } from '../util.js'
import type { FunctionEntry, Target } from './coverage.js'

/**
 * One instrumented expression. Several boxes can share a probe when a helper
 * is inlined in more than one place.
 */
export interface Probe {
  id: number
  /** site: an inlined call; enter: the start of a charted function's body. */
  kind: 'decision' | 'return' | 'reach' | 'site' | 'enter'
  span: Span
  /** Reach probes only: wrap the statement in braces instead of inserting before it. */
  wrap?: boolean
  /** The charted function (`file#name`) the probe is in, so what it records is tied to that function's run. */
  owner?: string
  /** Site probes: the charted function the call runs. */
  callee?: string
}

export interface ProbeTable {
  probes: Probe[]
  /** Chart node ID → probe IDs that stand for it. */
  byNode: Map<string, number[]>
  /** Boxes and outcomes whose code can't be found any more: the code changed under the chart. */
  missing: Set<string>
  /** Coverage target key → reach probe ID. */
  byTarget: Map<string, number>
  /** `file#name` of a charted function → probe at the start of its body. */
  byFunction: Map<string, number>
  /** Box → the call-site probes it must have been reached through, one list per route (empty: the entry function). */
  byVia: Map<string, number[][]>
  /** False for a chart made before boxes recorded their calls: answers then can't be tied to a call. */
  tied: boolean
}

/**
 * Every box's tested expression and every non-literal outcome's returned or
 * thrown expression. With `readFile`, spans are checked against the current
 * code and moved to where their expression is now, so saved charts still work
 * after edits elsewhere. A span that can't be found exactly once marks its box
 * as changed.
 */
export function probeTable(flow: AnyFlow, readFile?: (file: string) => string | undefined): ProbeTable {
  const probes: Probe[] = []
  const index = new Map<string, number>()
  const byNode = new Map<string, number[]>()
  const missing = new Set<string>()
  const locate = readFile ? locator(readFile) : (span: Span) => span
  const probeFor = (kind: Probe['kind'], original: Span): number | undefined => {
    const span = locate(original)
    if (!span) return undefined
    const key = `${kind}:${span.file}:${span.start}:${span.end}`
    let id = index.get(key)
    if (id === undefined) {
      id = probes.length
      probes.push({ id, kind, span, ...(span.owner ? { owner: span.owner } : {}), ...(span.callee ? { callee: span.callee } : {}) })
      index.set(key, id)
    }
    return id
  }
  const add = (nodeId: string, kind: Probe['kind'], original: Span): boolean => {
    const id = probeFor(kind, original)
    if (id === undefined) return false
    byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), id])
    return true
  }
  const byVia = new Map<string, number[][]>()
  for (const node of flow.nodes) {
    if ((node.kind === 'decision' || node.kind === 'outcome') && node.spans) {
      const kind = node.kind === 'decision' ? 'decision' : 'return'
      let found = 0
      for (const span of node.spans) if (add(node.id, kind, span)) found++
      // A box needs every copy. An outcome needs at least one of its return
      // statements, unless it's a literal, which is checked by its value.
      const literal = node.kind === 'outcome' && parseLiteral(node.value).ok
      const lost = kind === 'decision' ? found < node.spans.length : !literal && node.spans.length > 0 && found === 0
      if (lost) missing.add(node.id)
    }
    if (node.kind === 'decision' && node.via) {
      // Each route is the list of call sites the box is reached through. A route whose call can't be found is gone.
      const routes = node.via.flatMap((alt) => {
        const ids = alt.map((s) => probeFor('site', s))
        return ids.every((id) => id !== undefined) ? [ids as number[]] : []
      })
      if (!routes.length) missing.add(node.id)
      byVia.set(node.id, routes)
    }
  }
  const tied = flow.nodes.every((n) => n.kind !== 'decision' || !!n.via)
  return { probes, byNode, missing, byTarget: new Map(), byFunction: new Map(), byVia, tied }
}

/** Adds a probe per coverage target, which records that the code got there. */
export function addReachProbes(table: ProbeTable, targets: Target[]) {
  for (const t of targets) {
    const id = table.probes.length
    table.probes.push({ id, kind: 'reach', span: { file: t.file, start: t.insert.start, end: t.insert.end }, wrap: t.insert.wrap, owner: `${t.file}#${t.fn}` })
    table.byTarget.set(t.key, id)
  }
}

/** Adds a probe at the start of each charted function, which records that the code entered it. */
export function addEntryProbes(table: ProbeTable, entries: FunctionEntry[]) {
  for (const e of entries) {
    const id = table.probes.length
    table.probes.push({ id, kind: 'enter', span: { file: e.file, start: e.start, end: e.end ?? e.start }, owner: e.key, ...(e.end !== undefined ? { wrap: true } : {}) })
    table.byFunction.set(e.key, id)
  }
}

/** False when the charted function `file#name` has an entry probe that never fired. */
export function entered(table: ProbeTable, trace: Trace, key: string): boolean {
  const probe = table.byFunction.get(key)
  return probe === undefined || reachedProbes(trace).has(probe)
}

/** Reach probe IDs a trace recorded. */
export function reachedProbes(trace: Trace): Set<number> {
  return new Set(trace.events.filter((e) => e.reach).map((e) => e.p))
}

/**
 * Reach probe IDs recorded in runs the chart follows: the entry function's run
 * through run(), and helpers called from charted call sites inside it. A
 * helper run some other way (an earlier call the chart doesn't draw) doesn't count.
 */
export function chartedReach(trace: Trace, entryKey: string, tied = true): Set<number> {
  if (!tied) return reachedProbes(trace)
  const calls = callPaths(trace, entryKey)
  return new Set(trace.events.filter((e) => e.reach && e.i !== undefined && calls.get(e.i) !== undefined).map((e) => e.p))
}

/**
 * For each run of a charted function in the trace, the call sites from the
 * entry function's run down to it, or undefined when it wasn't reached
 * through charted calls only.
 */
export function callPaths(trace: Trace, entryKey: string): Map<number, number[] | undefined> {
  const runs = new Map((trace.invocations ?? []).map((r) => [r.id, r]))
  const root = (trace.invocations ?? []).find((r) => r.fn === entryKey && r.site === undefined)?.id
  const out = new Map<number, number[] | undefined>()
  const pathOf = (id: number, depth = 0): number[] | undefined => {
    if (out.has(id)) return out.get(id)
    const run = runs.get(id)
    let path: number[] | undefined
    if (!run || depth > 64) path = undefined
    else if (id === root) path = []
    else if (run.site === undefined || run.parent === undefined) path = undefined
    else {
      const parent = pathOf(run.parent, depth + 1)
      path = parent && [...parent, run.site]
    }
    out.set(id, path)
    return path
  }
  for (const id of runs.keys()) pathOf(id)
  return out
}

/**
 * Finds a span in the current code: in place, or the only other place where
 * the same text is a whole expression. Plain text search would also match
 * inside longer words (`x` in `export`), strings and type names, and putting
 * a probe there changes what the code does.
 */
function locator(readFile: (file: string) => string | undefined) {
  const files = new Map<string, { code: string; ranges: Ranges } | undefined>()
  const load = (file: string) => {
    if (!files.has(file)) {
      const code = readFile(file)
      files.set(file, code === undefined ? undefined : { code, ranges: expressionRanges(file, code) })
    }
    return files.get(file)
  }
  return (span: Span): Span | undefined => {
    const f = load(span.file)
    if (!f) return undefined
    if (!span.text) return span
    const found = occurrences(f.code, span.text, f.ranges, span.fn)
    const at = (start: number) => ({ ...span, start, end: start + span.text!.length })
    if (f.code.slice(span.start, span.end) === span.text && found.includes(span.start)) return span
    if (found.length === 1) return at(found[0]!)
    // The same expression appears more than once: take the same copy as before,
    // as long as the number of copies hasn't changed.
    if (span.nth !== undefined && span.of === found.length) return at(found[span.nth]!)
    return undefined
  }
}

/** What the instrumented code recorded during one test. */
export interface Trace {
  /** `i`: the run of the charted function the probe is in (see `invocations`). */
  events: { p: number; t?: boolean; v?: unknown; r?: boolean; reach?: boolean; i?: number }[]
  /** Each run of a charted function: which one, the call site it came from, and the run that made that call. */
  invocations?: { id: number; fn: string; site?: number; parent?: number }[]
  /** `probe`: the charted return or throw whose value is exactly what the function returned or threw. */
  result?: { value?: unknown; undefined?: boolean; threw?: boolean; message?: string; probe?: number; probeRun?: number }
  calls?: number
  /** Instrumented files that loaded, relative to the project root. */
  files?: string[]
}

export type RouteCheck =
  | { kind: 'verified'; note?: string }
  /** The code contradicted the chart: it skipped a box (`skipped`), or ended differently. */
  | { kind: 'failed'; note: string; skipped?: string }
  /** The test didn't drive the code down the intended path. */
  | { kind: 'missed'; note: string }
  /** The test itself errored or misused the helper. */
  | { kind: 'broken'; note: string }

/** Where walking the chart with a test's recorded answers ended. */
type WalkEnd =
  | { kind: 'outcome'; node: string }
  /** The chart says the code checks this box next, but it never did. */
  | { kind: 'skipped'; node: string }
  /** The box's code isn't in the file any more. */
  | { kind: 'changed'; node: string }
  /** The box has no instrumentation, so the walk can't go on. */
  | { kind: 'uninstrumented'; node: string }
  | { kind: 'undecidable'; node: string; value: unknown }
  | { kind: 'stuck'; node: string }
  /** An arrow points at a box that isn't in the chart. */
  | { kind: 'unknown'; node: string }
  /** The code answered this box in a way the chart has no arrow for. */
  | { kind: 'offChart'; node: string; answer: string; value: unknown }

export interface Walk {
  route: { node: string; edge: string }[]
  end: WalkEnd
  /** Index of the first trace event the walk didn't use. */
  cursor: number
}

/** Walks the chart from the start, answering each box the way the code did. */
export function followTrace(flow: AnyFlow, table: ProbeTable, trace: Trace): Walk {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]))
  const out = new Map<string, { label: string; to: string; value?: string }[]>()
  for (const e of flow.edges) out.set(e.from, [...(out.get(e.from) ?? []), { label: e.label, to: e.to, value: e.value }])
  let cursor = 0
  let node = flow.root
  const route: Walk['route'] = []
  const seen = new Set<string>()
  // Which run of each helper the walk is following, by the call sites that led to it.
  const entry = flow.flow.entry
  const paths = callPaths(trace, `${entry.file}#${entry.symbol}`)
  const bound = new Map<string, number>()
  const fromRightRun = (nodeId: string, e: Trace['events'][number]): string | false => {
    const routes = table.byVia.get(nodeId)
    if (!routes || !trace.invocations) return ''
    const path = e.i === undefined ? undefined : paths.get(e.i)
    if (!path) return false
    const key = path.join('>')
    if (!routes.some((r) => r.join('>') === key)) return false
    // Later boxes reached through the same calls must come from the same run.
    return bound.has(key) && bound.get(key) !== e.i ? false : key
  }
  for (;;) {
    const current = nodes.get(node)
    if (!current) return { route, cursor, end: { kind: 'unknown', node } }
    if (current.kind === 'outcome') return { route, cursor, end: { kind: 'outcome', node } }
    if (seen.has(node)) return { route, cursor, end: { kind: 'stuck', node } }
    seen.add(node)
    // Step boxes record nothing; the code just passes through them.
    if (current.kind !== 'decision') {
      route.push({ node, edge: 'next' })
      node = (out.get(node) ?? [])[0]?.to ?? node
      continue
    }
    if (table.missing.has(node)) return { route, cursor, end: { kind: 'changed', node } }
    const probes = new Set(table.byNode.get(node) ?? [])
    if (!probes.size) return { route, cursor, end: { kind: 'uninstrumented', node } }
    const index = trace.events.findIndex((e, i) => i >= cursor && !e.r && !e.reach && probes.has(e.p) && fromRightRun(node, e) !== false)
    if (index < 0) return { route, cursor, end: { kind: 'skipped', node } }
    const event = trace.events[index]!
    const key = fromRightRun(node, event)
    if (key && event.i !== undefined) bound.set(key, event.i)
    const edges = out.get(node) ?? []
    const answer = answerFor(current, edges, event)
    if (answer === undefined) return { route, cursor, end: { kind: 'undecidable', node, value: event.v } }
    const taken = edges.find((e) => e.label === answer)
    if (!taken) return { route, cursor, end: { kind: 'offChart', node, answer, value: event.v } }
    route.push({ node, edge: answer })
    cursor = index + 1
    node = taken.to
  }
}

function namer(flow: AnyFlow) {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]))
  return (id: string) => {
    const n = nodes.get(id)
    if (!n) return id
    return 'label' in n && n.label ? `"${n.label}"` : `\`${n.rawLabel}\``
  }
}

/** A failed or broken result for a walk that didn't reach an outcome. */
function unfinished(flow: AnyFlow, table: ProbeTable, walk: Walk, trace: Trace): RouteCheck {
  const name = namer(flow)
  const end = walk.end
  // Nothing contradicted the chart; Vantle just can't find the box's code any more.
  if (end.kind === 'changed') return { kind: 'broken', note: outOfDate(name(end.node)) }
  if (end.kind === 'undecidable') {
    if (end.value === '__promise') return { kind: 'broken', note: `${name(end.node)} was a promise when the code checked it, so its answer isn't known.` }
    return { kind: 'broken', note: `Couldn't tell which way ${name(end.node)} went (recorded ${JSON.stringify(end.value)}).` }
  }
  if (end.kind === 'uninstrumented') return { kind: 'broken', note: `${name(end.node)} has no instrumentation, so the route past it can't be checked.` }
  if (end.kind === 'unknown') return { kind: 'broken', note: `The chart has an arrow to a box that isn't in it (${end.node}). Run \`vantle generate\`.` }
  if (end.kind === 'offChart') {
    // A test can pass a value its type doesn't allow, which no case handles. That's not the chart's fault.
    const node = flow.nodes.find((n) => n.id === end.node)
    if (node?.kind === 'decision' && node.branch === 'switch') {
      return { kind: 'broken', note: `${name(end.node)} got ${JSON.stringify(end.value)}, which no case in the chart handles. Either the test passed a value its type doesn't allow, or the chart is missing a case.` }
    }
    return { kind: 'failed', note: `At ${name(end.node)}, the code answered ${end.answer}, but the chart has no ${end.answer} arrow there. The chart is missing a branch.` }
  }
  if (end.kind === 'skipped') {
    if (trace.result?.threw) return { kind: 'broken', note: `The code threw before reaching ${name(end.node)}: ${trace.result.message ?? ''}` }
    const notLoaded = unloadedFiles(table, end.node, trace)
    if (notLoaded.length) {
      return {
        kind: 'broken',
        note: `Vantle's instrumentation of ${notLoaded.join(', ')} didn't run, so the route can't be checked. The test may have mocked that module, or loaded it from another path.`,
      }
    }
    const last = walk.route.at(-1)
    const where = last ? `After ${name(last.node)} = ${last.edge}` : 'At the start'
    return { kind: 'failed', skipped: end.node, note: `${where}, the chart says the code checks ${name(end.node)} next, but it never did. The chart may be missing a branch here.` }
  }
  return { kind: 'broken', note: 'The chart has a loop, so the route could not be followed.' }
}

export function outOfDate(box: string): string {
  return `The code for ${box} changed, so the chart is out of date. Run \`vantle generate\`.`
}

/** The answers the code gave, as arrows, for as far as the chart can follow them. */
export function routeTaken(flow: AnyFlow, table: ProbeTable, trace: Trace): { node: string; edge: string }[] {
  return followTrace(flow, table, trace).route
}

/** Files holding this node's probes that never loaded instrumented in the test. */
function unloadedFiles(table: ProbeTable, node: string, trace: Trace): string[] {
  if (!trace.files) return []
  const loaded = new Set(trace.files)
  const files = new Set((table.byNode.get(node) ?? []).map((id) => table.probes[id]!.span.file))
  return [...files].filter((f) => !loaded.has(f))
}

/** A broken result when run() never entered the function under test. */
function entryNotRun(flow: AnyFlow, table: ProbeTable, trace: Trace): { kind: 'broken'; note: string } | undefined {
  const entry = flow.flow.entry
  if (entered(table, trace, `${entry.file}#${entry.symbol}`)) return undefined
  return { kind: 'broken', note: `The test never ran \`${entry.symbol}\` through run(), so nothing was checked.` }
}

/** Compares the route the code took with the path the test was written for. */
export function checkRoute(flow: AnyFlow, table: ProbeTable, path: FlowPath, trace: Trace): RouteCheck {
  const name = namer(flow)
  if ((trace.calls ?? 1) !== 1) return { kind: 'broken', note: 'The test must call run() exactly once.' }
  const notRun = entryNotRun(flow, table, trace)
  if (notRun) return notRun
  const walk = followTrace(flow, table, trace)

  // Stop at the first answer that differs from the intended path.
  for (const [i, taken] of walk.route.entries()) {
    const step = path.steps[i]
    if (step && step.node === taken.node && step.edge === taken.edge) continue
    const expected = step && step.node === taken.node && taken.edge !== 'next' ? step.edge : undefined
    return {
      kind: 'missed',
      note: expected
        ? `At ${name(taken.node)}, the code answered ${taken.edge} but this path needs ${expected}. Change the inputs so it answers ${expected}.`
        : `The code took a different route at step ${i + 1}.`,
    }
  }
  if (walk.end.kind !== 'outcome') return unfinished(flow, table, walk, trace)
  if (walk.route.length !== path.steps.length) return { kind: 'missed', note: 'The code finished before the end of the path.' }
  return checkOutcome(flow, table, walk.end.node, trace)
}

export type ReachCheck =
  /** The code followed the chart all the way to the outcome the code produced. */
  | { kind: 'holds'; note?: string }
  /** The code left the chart: the chart is missing a branch. `skipped` is the box the code never checked. */
  | { kind: 'gap'; note: string; skipped?: string }
  | { kind: 'broken'; note: string }

/**
 * For a test written to reach one place in the code, rather than to follow a
 * path: walks the chart with the answers the code gave, and checks the code
 * ended where the chart says it would.
 */
export function checkReach(flow: AnyFlow, table: ProbeTable, trace: Trace, target: { key: string; code: string; kind: string }): ReachCheck {
  if ((trace.calls ?? 1) !== 1) return { kind: 'broken', note: 'The test must call run() exactly once.' }
  const notRun = entryNotRun(flow, table, trace)
  if (notRun) return notRun
  const walk = followTrace(flow, table, trace)
  const name = namer(flow)
  const route = walk.route.length ? ` The code went: ${walk.route.map((s) => `${name(s.node)} ${s.edge}`).join(' → ')}.` : ''
  if (walk.end.kind === 'skipped' && trace.result?.threw && target.code.startsWith('throw') && reachedTarget(flow, trace, table, target)) {
    return { kind: 'gap', note: `The code threw at \`${target.code}\`, but the chart has no way to get there.${route}` }
  }
  // A chart whose code changed can't say whether a branch is missing.
  if (walk.end.kind === 'changed' || (walk.end.kind === 'outcome' && table.missing.has(walk.end.node))) {
    return { kind: 'broken', note: outOfDate(name(walk.end.node)) }
  }
  if (walk.end.kind !== 'outcome') {
    const check = unfinished(flow, table, walk, trace)
    return check.kind === 'failed' ? { kind: 'gap', note: check.note + route, skipped: check.skipped } : { kind: 'broken', note: check.note ?? '' }
  }
  const check = checkOutcome(flow, table, walk.end.node, trace)
  if (check.kind === 'verified') return { kind: 'holds', note: check.note }
  if (check.kind === 'failed') return { kind: 'gap', note: check.note + route }
  return { kind: 'broken', note: check.note ?? '' }
}

function reachedTarget(flow: AnyFlow, trace: Trace, table: ProbeTable, target: { key: string }): boolean {
  const probe = table.byTarget.get(target.key)
  return probe !== undefined && chartedReach(trace, entryKey(flow), table.tied).has(probe)
}

export function entryKey(flow: AnyFlow): string {
  return `${flow.flow.entry.file}#${flow.flow.entry.symbol}`
}

/** The chart's outcome must be what the code actually did. */
function checkOutcome(flow: AnyFlow, table: ProbeTable, outcomeId: string, trace: Trace): RouteCheck {
  const name = namer(flow)
  const outcome = flow.nodes.find((n) => n.id === outcomeId)
  if (!outcome || outcome.kind !== 'outcome') return { kind: 'broken', note: `The chart has an arrow to a box that isn't in it (${outcomeId}).` }
  if (table.missing.has(outcome.id)) return { kind: 'broken', note: outOfDate(name(outcome.id)) }
  const result = trace.result
  if (!result) return { kind: 'broken', note: 'No result was recorded. Call the function through run().' }
  const probes = new Set(table.byNode.get(outcome.id) ?? [])
  // A return or throw only counts when it ran in a run the chart follows, not in an earlier call it doesn't draw.
  const followed = !table.tied || result.probeRun === undefined || !trace.invocations || callPaths(trace, entryKey(flow)).get(result.probeRun) !== undefined
  const fired = followed ? result.probe : undefined
  const other = () => {
    const node = fired !== undefined && flow.nodes.find((n) => n.kind === 'outcome' && (table.byNode.get(n.id) ?? []).includes(fired))
    return node ? name(node.id) : 'a different return'
  }

  if (outcome.value.startsWith('throw ')) {
    if (!result.threw) return { kind: 'failed', note: `The chart says the code throws here, but it returned ${show(result)}.` }
    if (!probes.size) return { kind: 'broken', note: `Vantle can't tell which throw ran, because the chart doesn't record where ${name(outcome.id)} is. Run \`vantle generate\`.` }
    if (fired !== undefined && probes.has(fired)) return { kind: 'verified' }
    if (fired !== undefined) return { kind: 'failed', note: `The chart says the code ends with ${name(outcome.id)}, but it ended through ${other()}.` }
    return { kind: 'broken', note: `The code threw, but not the error from ${name(outcome.id)}: ${result.message ?? ''}` }
  }
  if (result.threw) return { kind: 'broken', note: `The code threw instead of returning: ${result.message ?? ''}` }
  const literal = parseLiteral(outcome.value)
  if (literal.ok) {
    const actual = result.undefined ? undefined : result.value
    return JSON.stringify(actual) === JSON.stringify(literal.value) && (literal.value === undefined) === !!result.undefined
      ? { kind: 'verified' }
      : { kind: 'failed', note: `The chart says the code returns ${outcome.value} here, but it returned ${show(result)}.` }
  }
  // Not a literal: the result must be the value one of this outcome's return statements handed back.
  if (!probes.size) return { kind: 'broken', note: `${name(outcome.id)} has no instrumentation, so Vantle can't tell whether it ran.` }
  if (fired !== undefined && probes.has(fired)) return { kind: 'verified' }
  if (fired !== undefined) return { kind: 'failed', note: `The chart says the code ends with ${name(outcome.id)}, but it returned through ${other()}.` }
  return { kind: 'broken', note: `The result didn't come from a return the chart knows about, so Vantle can't tell which one ran.` }
}

function answerFor(node: AnyFlow['nodes'][number], edges: { label: string; value?: string }[], event: Trace['events'][number]): string | undefined {
  if (node.kind !== 'decision') return undefined
  if (event.v === '__promise') return undefined
  if (node.branch === 'boolean') return event.t ? 'yes' : 'no'
  const cases = edges.filter((e) => e.label !== 'default' && e.label !== 'other')
  // A case written as a name (`Status.Active`) carries the value it stands for.
  const valueOf = (c: { label: string; value?: string }) => (c.value !== undefined ? { ok: true as const, value: JSON.parse(c.value) as unknown } : parseLiteral(c.label))
  // The probe records undefined as a marker; objects never equal a literal case.
  const actual = event.v === '__undefined' ? undefined : event.v
  if (actual !== '__object') {
    for (const c of cases) {
      const lit = valueOf(c)
      // As `switch` compares: strictly. (Traces are saved as JSON, so NaN and Infinity read as null.)
      if (lit.ok && lit.value === actual) return c.label
    }
  }
  if (cases.some((c) => !valueOf(c).ok)) return undefined
  // No case matched. With no default arrow, the code went somewhere the chart doesn't draw.
  return edges.find((e) => e.label === 'default' || e.label === 'other')?.label ?? 'other'
}

/** Parses simple literals as written in code: true, 3, 'a', "a", null, undefined. */
export function parseLiteral(code: string): { ok: true; value: unknown } | { ok: false } {
  const text = normalizeCode(code)
  if (text === 'undefined') return { ok: true, value: undefined }
  if (/^'(?:[^'\\]|\\.)*'$/.test(text)) return { ok: true, value: text.slice(1, -1).replace(/\\'/g, "'") }
  if (/^`[^`$]*`$/.test(text)) return { ok: true, value: text.slice(1, -1) }
  try {
    const value = JSON.parse(text)
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return { ok: true, value }
  } catch {
    // Not a literal.
  }
  return { ok: false }
}

function show(result: NonNullable<Trace['result']>): string {
  if (result.threw) return `an error (${result.message ?? ''})`
  if (result.undefined) return 'undefined'
  const text = JSON.stringify(result.value)
  return text && text.length > 120 ? `${text.slice(0, 120)}…` : String(text)
}

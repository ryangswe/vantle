import type { FlowEdge, FlowNode } from '../schema/flow.js'
import { normalizeCode } from '../util.js'

/** A minimal decision graph. Both extracted flows and hand-written references convert to it. */
export interface Graph {
  root: string
  nodes: Map<string, GraphNode>
}

export interface GraphNode {
  id: string
  kind: 'decision' | 'outcome' | 'opaque' | 'action'
  /** Actions: values this step sets, which later checks of those variables must agree with. */
  assigns?: { variable: string; value: string }[]
  branch?: 'boolean' | 'switch'
  /** Condition (boolean) or discriminant (switch). */
  test?: string
  /** Set when this test can answer differently from another one with the same code. */
  identity?: string
  /** Returned value, for outcomes. */
  value?: string
  edges: { label: string; to: string }[]
}

export function toGraph(root: string, nodes: FlowNode[], edges: FlowEdge[]): Graph {
  const map = new Map<string, GraphNode>()
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id,
      kind: n.kind,
      branch: n.kind === 'decision' ? n.branch : undefined,
      test: n.kind === 'decision' ? n.rawLabel : undefined,
      identity: n.kind === 'decision' ? n.identity : undefined,
      value: n.kind === 'outcome' ? n.value : undefined,
      assigns: n.kind === 'action' ? n.assigns : undefined,
      edges: [],
    })
  }
  for (const e of edges) map.get(e.from)?.edges.push({ label: e.label, to: e.to })
  return { root, nodes: map }
}

// ---- constraints ----------------------------------------------------------

/**
 * What a path assumes about one variable. `allowed` undefined means any value
 * not in `excluded`. Booleans use the values 'true' and 'false'.
 */
export interface Constraint {
  allowed?: Set<string>
  excluded: Set<string>
}

export type Assumptions = Map<string, Constraint>

const LITERAL = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|undefined`
const COMPARISON = new RegExp(String.raw`^(.+?)\s*(===|!==|==|!=)\s*(${LITERAL})$`)

/** The variable an edge tests and the values that take that edge. */
export function edgeConstraint(node: GraphNode, label: string): { variable: string; constraint: Constraint } | undefined {
  if (node.kind !== 'decision' || node.test === undefined) return undefined
  // Two tests with the same code are one question, unless one can answer differently.
  const id = node.identity ? `#${node.identity}` : ''
  const test = canonical(node.test) + id

  if (node.branch === 'switch') {
    if (label === 'default' || label === 'other') {
      const cases = node.edges.filter((e) => e.label !== 'default' && e.label !== 'other').map((e) => literalKey(canonical(e.label)))
      return { variable: test, constraint: { excluded: new Set(cases) } }
    }
    return { variable: test, constraint: { allowed: new Set([literalKey(canonical(label))]), excluded: new Set() } }
  }

  const yes = label === 'yes'
  // `x === 'a'` and `x !== 'a'` are facts about `x`, so they line up with a switch on `x`.
  const match = COMPARISON.exec(canonical(node.test))
  if (match && isAtom(match[1]!)) {
    const variable = canonical(match[1]!) + id
    const literal = literalKey(canonical(match[3]!))
    const strict = match[2] === '===' || match[2] === '!=='
    const equal = match[2] === '===' || match[2] === '=='
    // `==` converts types, so only `x == null` (null or undefined) is a fact about `x`.
    const values = strict ? [literal] : literal === 'null' || literal === 'undefined' ? ['null', 'undefined'] : undefined
    if (values) {
      return yes === equal
        ? { variable, constraint: { allowed: new Set(values), excluded: new Set() } }
        : { variable, constraint: { excluded: new Set(values) } }
    }
  }
  // Whether `x` is truthy is a different question from what it equals (`x` after `x === 'a'`
  // can't be no, but after `x !== 'a'` it can be either), so it has its own key. `assume`
  // links the two where a literal decides it.
  return { variable: truthy(test), constraint: { allowed: new Set([yes ? 'true' : 'false']), excluded: new Set() } }
}

/** The key for whether `test` is truthy, apart from the key for its value. */
function truthy(test: string): string {
  return `!!${test}`
}

/** Adds `c` to `assumptions` for `variable`. Returns undefined when they contradict. */
export function assume(assumptions: Assumptions, variable: string, c: Constraint): Assumptions | undefined {
  const prev = assumptions.get(variable)
  const merged = prev ? intersect(prev, c) : c
  if (!feasible(merged)) return undefined
  const next = new Map(assumptions)
  next.set(variable, merged)
  return linkTruthiness(next, variable.startsWith('!!') ? variable.slice(2) : variable)
}

/**
 * Keeps what a value equals and whether it's truthy consistent: `x === 'a'` means `x`
 * is truthy, `x == null` that it isn't, and `x` falsy rules out `x === 'a'`. Only when
 * every value `x` may hold is a literal whose truthiness is known; otherwise nothing.
 */
function linkTruthiness(assumptions: Assumptions, value: string): Assumptions | undefined {
  const v = assumptions.get(value)
  if (!v?.allowed) return assumptions
  const truths = [...v.allowed].filter((x) => !v.excluded.has(x)).map(truthOf)
  if (truths.some((t) => t === undefined)) return assumptions
  const key = truthy(value)
  const prev = assumptions.get(key)
  const can = new Set(truths.map((t) => (t ? 'true' : 'false')))
  if (!prev && can.size > 1) return assumptions
  const merged = intersect(prev ?? { excluded: new Set() }, { allowed: can, excluded: new Set() })
  if (!feasible(merged)) return undefined
  assumptions.set(key, merged)
  return assumptions
}

function intersect(a: Constraint, b: Constraint): Constraint {
  let allowed: Set<string> | undefined
  if (a.allowed && b.allowed) allowed = new Set([...a.allowed].filter((v) => b.allowed!.has(v)))
  else allowed = a.allowed ?? b.allowed
  return { allowed, excluded: new Set([...a.excluded, ...b.excluded]) }
}

function feasible(c: Constraint): boolean {
  if (!c.allowed) return true
  return [...c.allowed].some((v) => !c.excluded.has(v))
}

/**
 * Literal values an action sets become facts about the variable and whether it's
 * truthy; anything else makes it unknown again. (Only the entry function's step
 * boxes set anything: a helper's local and the caller's variable can share a name.)
 */
function applyAssigns(assumptions: Assumptions, assigns: { variable: string; value: string }[]): Assumptions {
  if (!assigns.length) return assumptions
  const next = new Map(assumptions)
  for (const { variable, value } of assigns) {
    const v = canonical(variable)
    const literal = literalValue(value)
    next.delete(v)
    next.delete(truthy(v))
    if (literal !== undefined) next.set(v, { allowed: new Set([literal]), excluded: new Set() })
    const t = literal === undefined ? undefined : truthOf(literal)
    if (t !== undefined) next.set(truthy(v), { allowed: new Set([t ? 'true' : 'false']), excluded: new Set() })
  }
  return next
}

/** Whether a literal, as `literalValue` writes it, is truthy in JavaScript; undefined for anything else. */
function truthOf(literal: string): boolean | undefined {
  if (literal === 'true') return true
  if (literal === 'false' || literal === 'null' || literal === 'undefined') return false
  if (/^-?\d+(\.\d+)?$/.test(literal)) return Number(literal) !== 0
  if (/^'(?:[^'\\]|\\.)*'$/.test(literal)) return literal !== "''"
  return undefined
}

/** One spelling per number, so `0`, `-0` and `0.0` are one value, as `===` says. */
function literalKey(text: string): string {
  return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text
}

/** A value's constraint key: 'true'/'false' for booleans, the canonical code for other literals. */
function literalValue(code: string): string | undefined {
  const text = canonical(code)
  if (/^(true|false|null|undefined|-?\d+(\.\d+)?|'(?:[^'\\]|\\.)*')$/.test(text)) return literalKey(text)
  return undefined
}

function canonical(code: string): string {
  return normalizeCode(code).replace(/"((?:[^"\\]|\\.)*)"/g, "'$1'")
}

/** True when `text` has no operators outside parentheses or brackets. */
function isAtom(text: string): boolean {
  let depth = 0
  let quote: string | undefined
  for (const ch of text.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && /[\s|&?!<>=+\-*/%,:]/.test(ch)) return false
  }
  return true
}

// ---- paths ----------------------------------------------------------------

export interface GraphPath {
  steps: { node: string; edge: string }[]
  outcome: string
  assumptions: Assumptions
}

/**
 * Lists every path from the root to an outcome, skipping paths that contradict
 * themselves (for example, testing the same condition twice with different answers).
 */
export function enumeratePaths(graph: Graph, maxPaths: number): { paths: GraphPath[]; truncated: boolean } {
  const paths: GraphPath[] = []
  let truncated = false
  const onPath = new Set<string>()

  const walk = (id: string, steps: GraphPath['steps'], assumptions: Assumptions) => {
    if (truncated) return
    const node = graph.nodes.get(id)
    // An arrow to a box that doesn't exist is a broken chart, not a path to skip.
    if (!node) throw new Error(`The chart has an arrow to a box that isn't in it (${id}).`)
    if (onPath.has(id)) return
    if (node.kind === 'outcome') {
      if (paths.length >= maxPaths) {
        truncated = true
        return
      }
      paths.push({ steps, outcome: id, assumptions })
      return
    }
    onPath.add(id)
    for (const edge of node.edges) {
      const next = step(node, assumptions, edge.label)
      if (next) walk(edge.to, [...steps, { node: id, edge: edge.label }], next)
    }
    onPath.delete(id)
  }

  walk(graph.root, [], new Map())
  return { paths, truncated }
}

/**
 * What a path knows after leaving `node` by the arrow `label`, or undefined when
 * that arrow contradicts what it knew. Path listing and route replay share this,
 * so they always rule out the same things.
 */
export function step(node: GraphNode, assumptions: Assumptions, label: string): Assumptions | undefined {
  // An action replaces what the path knew about the variables it sets.
  const base = node.kind === 'action' ? applyAssigns(assumptions, node.assigns ?? []) : assumptions
  const c = edgeConstraint(node, label)
  return c ? assume(base, c.variable, c.constraint) : base
}

/**
 * Replays a route the code took through the chart's own path logic. Returns the
 * index of the first step the chart says can't happen after the ones before it,
 * or undefined when the chart allows the whole route.
 */
export function contradiction(graph: Graph, route: { node: string; edge: string }[]): number | undefined {
  let assumptions: Assumptions = new Map()
  for (const [i, s] of route.entries()) {
    const node = graph.nodes.get(s.node)
    if (!node) return i
    const next = step(node, assumptions, s.edge)
    if (!next) return i
    assumptions = next
  }
  return undefined
}

// ---- equivalence ----------------------------------------------------------

export interface Counterexample {
  /** Variable → value that sends the two graphs to different outcomes. */
  inputs: Record<string, string>
  expected: string
  actual: string
}

export interface Equivalence {
  equivalent: boolean
  counterexamples: Counterexample[]
  /** Conditions that appear in only one graph. Usually the first thing to look at when they differ. */
  onlyInExpected: string[]
  onlyInActual: string[]
  expectedPaths: number
  actualPaths: number
}

/**
 * Checks two graphs make the same decision for every input. Every input follows
 * exactly one path in each graph, so the graphs differ exactly when some path
 * pair is consistent (no variable needs two values) but ends in different outcomes.
 */
export function compareBehavior(expected: Graph, actual: Graph, maxPaths = 100_000): Equivalence {
  const e = enumeratePaths(expected, maxPaths)
  const a = enumeratePaths(actual, maxPaths)
  if (e.truncated || a.truncated) throw new Error(`Too many paths to compare (more than ${maxPaths}).`)

  const counterexamples: Counterexample[] = []
  for (const pe of e.paths) {
    for (const pa of a.paths) {
      const expectedValue = outcomeValue(expected, pe.outcome)
      const actualValue = outcomeValue(actual, pa.outcome)
      if (expectedValue === actualValue) continue
      let merged: Assumptions | undefined = pe.assumptions
      for (const [variable, c] of pa.assumptions) {
        merged = assume(merged, variable, c)
        if (!merged) break
      }
      if (merged) {
        counterexamples.push({ inputs: describe(merged), expected: expectedValue, actual: actualValue })
        if (counterexamples.length >= 5) break
      }
    }
    if (counterexamples.length >= 5) break
  }

  const ve = variables(expected)
  const va = variables(actual)
  return {
    equivalent: counterexamples.length === 0,
    counterexamples,
    onlyInExpected: [...ve].filter((v) => !va.has(v)).sort(),
    onlyInActual: [...va].filter((v) => !ve.has(v)).sort(),
    expectedPaths: e.paths.length,
    actualPaths: a.paths.length,
  }
}

function outcomeValue(graph: Graph, id: string): string {
  return canonical(graph.nodes.get(id)?.value ?? id)
}

function variables(graph: Graph): Set<string> {
  const keys = new Set<string>()
  for (const node of graph.nodes.values()) {
    for (const edge of node.edges) {
      const c = edgeConstraint(node, edge.label)
      if (c) keys.add(c.variable)
    }
  }
  // Whether `x` is truthy and what it equals are one condition, `x`, to a reader.
  return new Set([...keys].map((k) => (k.startsWith('!!') ? k.slice(2) : k)))
}

function describe(assumptions: Assumptions): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = new Set(assumptions.keys())
  for (const [variable, c] of assumptions) {
    const allowed = c.allowed ? [...c.allowed].filter((v) => !c.excluded.has(v)) : undefined
    out[shownAs(variable, keys)] = allowed ? allowed.join(' | ') : `not ${[...c.excluded].join(', ')}`
  }
  return out
}

/** A key as people read it: whether `x` is truthy is just `x`, unless what `x` equals is a key too. */
function shownAs(key: string, keys: Set<string>): string {
  if (!key.startsWith('!!')) return key
  const plain = key.slice(2)
  return keys.has(plain) ? `${plain} (truthy)` : plain
}

import { assume, edgeConstraint, enumeratePaths, toGraph, type Assumptions, type Constraint, type Graph, type GraphPath } from '../graph/paths.js'
import type { FlowEdge } from '../schema/flow.js'
import type { AnyFlow } from '../schema/labeled.js'
import { shortHash } from '../util.js'

/** An arrow in the chart: a node and the answer that leaves it. */
export const arrowKey = (node: string, edge: string) => `${node}|${edge}`

export function arrows(edges: FlowEdge[]): string[] {
  return [...new Set(edges.map((e) => arrowKey(e.from, e.label)))]
}

/** Stable identity for a path, so a saved test can be matched to it later. */
export function pathSignature(p: Pick<GraphPath, 'steps' | 'outcome'>): string {
  return shortHash(JSON.stringify([p.steps.map((s) => [s.node, s.edge]), p.outcome]), 10)
}

/** Answers that can't all happen together in the real code, as reported by the test writer. */
export interface Conflict {
  arrows: { node: string; edge: string }[]
  reason: string
}

export interface SelectOptions {
  /** Test every path instead of a set that covers every arrow. */
  allPaths?: boolean
  /** Paths known to be impossible are skipped when they contain one of these. */
  conflicts?: Conflict[]
  /** Only pick paths that cover these arrows (used to refill gaps). */
  onlyArrows?: Set<string>
  /** Signatures to skip. */
  exclude?: Set<string>
  limit?: number
}

export function flowGraph(flow: AnyFlow): Graph {
  return toGraph(flow.root, flow.nodes, flow.edges)
}

/**
 * Picks paths so that every arrow is on at least one of them, greedily taking
 * the path that covers the most uncovered arrows each time. For the Slack
 * fixture, 20 of 1,311 paths cover all 57 arrows.
 */
export function selectPaths(flow: AnyFlow, options: SelectOptions = {}): GraphPath[] {
  const graph = flowGraph(flow)
  const all = enumeratePaths(graph, 100_000).paths.filter(
    (p) => !options.exclude?.has(pathSignature(p)) && !(options.conflicts ?? []).some((c) => hasConflict(graph, p, c)),
  )
  if (options.allPaths) return all.slice(0, options.limit ?? 200)

  const target = options.onlyArrows ?? new Set(arrows(flow.edges))
  const uncovered = new Set(target)
  const chosen: GraphPath[] = []
  while (uncovered.size && chosen.length < (options.limit ?? 200)) {
    let best: GraphPath | undefined
    let gain = 0
    for (const p of all) {
      const n = new Set(p.steps.map((s) => arrowKey(s.node, s.edge)).filter((a) => uncovered.has(a))).size
      // Prefer more new arrows, then shorter paths (simpler tests).
      if (n > gain || (n === gain && n > 0 && best && p.steps.length < best.steps.length)) {
        best = p
        gain = n
      }
    }
    if (!best) break
    chosen.push(best)
    for (const s of best.steps) uncovered.delete(arrowKey(s.node, s.edge))
  }
  return chosen
}

/**
 * True when a path's answers force every answer in the conflict. Only the answers the
 * path gives at its boxes count, not what step boxes set: a step after a box can set
 * the same variable, and that says nothing about how the box was answered.
 */
export function hasConflict(graph: Graph, path: Pick<GraphPath, 'steps'>, conflict: Conflict): boolean {
  if (conflict.arrows.length < 2) return false
  let assumptions: Assumptions = new Map()
  for (const s of path.steps) {
    const n = graph.nodes.get(s.node)
    const c = n?.kind === 'decision' ? edgeConstraint(n, s.edge) : undefined
    if (!c) continue
    // A box asked again after its value changed can answer differently; the later answer stands.
    assumptions = assume(assumptions, c.variable, c.constraint) ?? new Map([...assumptions, [c.variable, c.constraint]])
  }
  return conflict.arrows.every(({ node, edge }) => {
    const n = graph.nodes.get(node)
    const c = n && edgeConstraint(n, edge)
    if (!c) return false
    const held = assumptions.get(c.variable)
    const opposite = negate(c.constraint)
    // Forced means: the path's assumption about this condition rules out every other answer.
    return held !== undefined && opposite !== undefined && assume(new Map([[c.variable, held]]), c.variable, opposite) === undefined
  })
}

function negate(c: Constraint): Constraint | undefined {
  if (c.allowed && c.excluded.size === 0) return { excluded: new Set(c.allowed) }
  if (!c.allowed) return { allowed: new Set(c.excluded), excluded: new Set() }
  return undefined
}

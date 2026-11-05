import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Graph, GraphNode } from './paths.js'

/**
 * A hand-written reference chart (`expected.json`). Edges point at other node
 * keys or at outcome names. `label` is the reference product-language label.
 */
const ExpectedNode = z.union([
  z.object({ label: z.string(), test: z.string(), yes: z.string(), no: z.string() }),
  z.object({
    label: z.string(),
    switch: z.string(),
    cases: z.record(z.string(), z.string()),
    otherwise: z.string().optional(),
  }),
])

export const ExpectedFlow = z.object({
  flow: z.string(),
  root: z.string(),
  /** Outcome name → returned value, e.g. { "YES": "true" }. */
  outcomes: z.record(z.string(), z.string()),
  nodes: z.record(z.string(), ExpectedNode),
})
export type ExpectedFlow = z.infer<typeof ExpectedFlow>

export function loadExpected(file: string): ExpectedFlow {
  return ExpectedFlow.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export function expectedToGraph(expected: ExpectedFlow): Graph {
  const nodes = new Map<string, GraphNode>()
  const target = (key: string) => {
    if (key in expected.outcomes || key in expected.nodes) return key
    throw new Error(`expected.json: "${key}" is neither a node nor an outcome`)
  }
  for (const [name, value] of Object.entries(expected.outcomes)) {
    nodes.set(name, { id: name, kind: 'outcome', value, edges: [] })
  }
  for (const [key, node] of Object.entries(expected.nodes)) {
    if ('test' in node) {
      nodes.set(key, {
        id: key,
        kind: 'decision',
        branch: 'boolean',
        test: node.test,
        edges: [
          { label: 'yes', to: target(node.yes) },
          { label: 'no', to: target(node.no) },
        ],
      })
    } else {
      const edges = Object.entries(node.cases).map(([label, to]) => ({ label, to: target(to) }))
      if (node.otherwise) edges.push({ label: 'other', to: target(node.otherwise) })
      nodes.set(key, { id: key, kind: 'decision', branch: 'switch', test: node.switch, edges })
    }
  }
  return { root: target(expected.root), nodes }
}

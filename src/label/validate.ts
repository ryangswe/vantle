import { compareBehavior, toGraph } from '../graph/paths.js'
import type { FlowEdge, RawFlow } from '../schema/flow.js'
import type { LabeledNode, LabelOutput } from '../schema/labeled.js'
import { normalizeCode } from '../util.js'

/** Short IDs (n1, o1, …) shown to the model, mapped to full node IDs. */
export interface ShortIds {
  toFull: Map<string, string>
  toShort: Map<string, string>
}

export function shortIds(flow: { nodes: { id: string; kind: string }[] }): ShortIds {
  const toFull = new Map<string, string>()
  const toShort = new Map<string, string>()
  let d = 0
  let o = 0
  let a = 0
  for (const node of flow.nodes) {
    const short = node.kind === 'outcome' ? `o${++o}` : node.kind === 'decision' ? `n${++d}` : node.kind === 'action' ? `a${++a}` : undefined
    if (!short) continue
    toFull.set(short, node.id)
    toShort.set(node.id, short)
  }
  return { toFull, toShort }
}

export const MAX_LABEL_LENGTH = 90

export type ValidationResult =
  | { ok: true; nodes: LabeledNode[]; edges: FlowEdge[]; root: string }
  | { ok: false; errors: string[] }

/**
 * Checks the model's labels against the raw flow and builds the labeled chart.
 *
 * The rules: every box is labeled exactly once, no IDs are invented, merged
 * boxes make the same decision and lead to the same places, every outcome is
 * kept, and the labeled chart behaves exactly like the raw one for every input.
 */
export function validateLabels(raw: RawFlow, output: LabelOutput, ids: ShortIds = shortIds(raw)): ValidationResult {
  const errors: string[] = []
  const byId = new Map(raw.nodes.map((n) => [n.id, n]))
  const decisions = raw.nodes.filter((n) => n.kind === 'decision')
  const outcomes = raw.nodes.filter((n) => n.kind === 'outcome')

  // Every decision box appears in exactly one group.
  const groupOf = new Map<string, number>()
  output.boxes.forEach((box, i) => {
    if (box.ids.length === 0) errors.push(`Box ${i + 1} ("${box.label}") lists no IDs.`)
    for (const short of box.ids) {
      const full = ids.toFull.get(short)
      const node = full ? byId.get(full) : undefined
      if (!full || !node) {
        errors.push(`"${short}" is not a box in this chart.`)
        continue
      }
      if (node.kind !== 'decision') {
        errors.push(`"${short}" is an outcome; label it under "outcomes", not "boxes".`)
        continue
      }
      if (groupOf.has(full)) errors.push(`"${short}" is labeled more than once.`)
      groupOf.set(full, i)
    }
  })
  for (const d of decisions) {
    if (!groupOf.has(d.id)) errors.push(`"${ids.toShort.get(d.id)}" (\`${d.rawLabel}\`) has no label.`)
  }

  // Every outcome is labeled exactly once.
  const outcomeLabel = new Map<string, string>()
  for (const o of output.outcomes) {
    const full = ids.toFull.get(o.id)
    if (!full || byId.get(full)?.kind !== 'outcome') {
      errors.push(`"${o.id}" is not an outcome in this chart.`)
      continue
    }
    if (outcomeLabel.has(full)) errors.push(`Outcome "${o.id}" is labeled more than once.`)
    outcomeLabel.set(full, o.label)
  }
  for (const o of outcomes) {
    if (!outcomeLabel.has(o.id)) errors.push(`Outcome "${ids.toShort.get(o.id)}" (\`${o.rawLabel}\`) has no label.`)
  }

  // Every action is labeled exactly once.
  const actionLabel = new Map<string, string>()
  for (const act of output.actions ?? []) {
    const full = ids.toFull.get(act.id)
    if (!full || byId.get(full)?.kind !== 'action') {
      errors.push(`"${act.id}" is not an action in this chart.`)
      continue
    }
    if (actionLabel.has(full)) errors.push(`Action "${act.id}" is labeled more than once.`)
    actionLabel.set(full, act.label)
  }
  for (const n of raw.nodes) {
    if (n.kind === 'action' && !actionLabel.has(n.id)) errors.push(`Action "${ids.toShort.get(n.id)}" (\`${n.rawLabel}\`) has no label.`)
  }

  // Labels must be short, one line, and explained.
  const checkText = (what: string, text: string) => {
    if (!text.trim()) errors.push(`${what} is empty.`)
    else if (text.length > MAX_LABEL_LENGTH) errors.push(`${what} is longer than ${MAX_LABEL_LENGTH} characters.`)
    else if (/\n/.test(text)) errors.push(`${what} spans more than one line.`)
  }
  output.boxes.forEach((box) => {
    const name = box.ids.join('+') || '(no IDs)'
    checkText(`Label for ${name}`, box.label)
    if (!box.rationale.trim()) errors.push(`Rationale for ${name} is empty.`)
  })
  output.outcomes.forEach((o) => checkText(`Label for outcome ${o.id}`, o.label))
  ;(output.actions ?? []).forEach((a) => checkText(`Label for action ${a.id}`, a.label))

  // Case labels only on switches, and only for values the switch has.
  output.boxes.forEach((box) => {
    for (const short of box.ids) {
      const node = byId.get(ids.toFull.get(short) ?? '')
      if (node?.kind !== 'decision') continue
      const values = new Set(raw.edges.filter((e) => e.from === node.id).map((e) => normalizeCode(e.label)))
      for (const c of box.caseLabels) {
        if (node.branch !== 'switch') errors.push(`${short} is a yes/no box, so it can't have case labels.`)
        else if (!values.has(normalizeCode(c.value))) errors.push(`${short} has no case ${c.value}. Its cases are: ${[...values].join(', ')}.`)
        checkText(`Case label ${c.value} on ${short}`, c.label)
      }
    }
  })

  // The same condition gets the same label everywhere, so readers don't think they're different checks.
  const labelsByCondition = new Map<string, Map<string, string[]>>()
  output.boxes.forEach((box) => {
    for (const short of box.ids) {
      const node = byId.get(ids.toFull.get(short) ?? '')
      if (node?.kind !== 'decision') continue
      const byLabel = labelsByCondition.get(normalizeCode(node.rawLabel)) ?? new Map<string, string[]>()
      byLabel.set(box.label.trim(), [...(byLabel.get(box.label.trim()) ?? []), short])
      labelsByCondition.set(normalizeCode(node.rawLabel), byLabel)
    }
  })
  for (const [condition, byLabel] of labelsByCondition) {
    if (byLabel.size > 1) {
      const variants = [...byLabel].map(([label, shorts]) => `"${label}" (${shorts.join(', ')})`).join(' vs ')
      errors.push(`\`${condition}\` has different labels in different boxes: ${variants}. Use one label for all of them.`)
    }
  }

  if (errors.length) return { ok: false, errors }

  // Merged boxes must test the same thing and lead to the same places.
  const representative = (id: string): string => {
    const group = groupOf.get(id)
    return group === undefined ? id : ids.toFull.get(output.boxes[group]!.ids[0]!)!
  }
  const outgoing = (id: string) =>
    raw.edges
      .filter((e) => e.from === id)
      .map((e) => `${normalizeCode(e.label)}→${representative(e.to)}`)
      .sort()
      .join('|')
  output.boxes.forEach((box) => {
    if (box.ids.length < 2) return
    const members = box.ids.map((s) => byId.get(ids.toFull.get(s)!)!)
    const first = members[0]!
    for (const other of members.slice(1)) {
      if (first.kind !== 'decision' || other.kind !== 'decision') continue
      if (normalizeCode(first.rawLabel) !== normalizeCode(other.rawLabel) || first.branch !== other.branch) {
        errors.push(`Can't merge ${box.ids.join('+')}: they test different conditions.`)
      } else if (first.identity !== other.identity) {
        errors.push(`Can't merge ${box.ids.join('+')}: the same code, but it can give a different answer each time (a value changed in between, or each call is separate).`)
      } else if (outgoing(first.id) !== outgoing(other.id)) {
        errors.push(`Can't merge ${box.ids.join('+')}: they test the same condition but lead to different places.`)
      }
    }
  })
  if (errors.length) return { ok: false, errors }

  // Build the labeled chart.
  const nodes: LabeledNode[] = []
  for (const node of raw.nodes) {
    if (node.kind === 'outcome') {
      nodes.push({ ...node, label: outcomeLabel.get(node.id)! })
    } else if (node.kind === 'opaque') {
      nodes.push({ ...node, label: node.rawLabel })
    } else if (node.kind === 'action') {
      nodes.push({ ...node, label: actionLabel.get(node.id)!.trim() })
    } else if (representative(node.id) === node.id) {
      const box = output.boxes[groupOf.get(node.id)!]!
      nodes.push({
        ...node,
        label: box.label.trim(),
        category: box.category,
        rationale: box.rationale.trim(),
        rawIds: box.ids.map((s) => ids.toFull.get(s)!),
        spans: box.ids.flatMap((s) => {
          const member = byId.get(ids.toFull.get(s)!)
          return member?.kind === 'decision' ? (member.spans ?? []) : []
        }),
        // A merged box takes answers from any of its members' calls. A chart made before routes were recorded has none.
        ...(() => {
          const members = box.ids.map((s) => byId.get(ids.toFull.get(s)!))
          if (!members.every((m) => m?.kind === 'decision' && m.via)) return {}
          return { via: members.flatMap((m) => (m?.kind === 'decision' ? m.via! : [])) }
        })(),
        caseLabels: Object.fromEntries(box.caseLabels.map((c) => [normalizeCode(c.value), c.label.trim()])),
      })
    }
  }
  const kept = new Set(nodes.map((n) => n.id))
  const seen = new Set<string>()
  const edges: FlowEdge[] = []
  for (const e of raw.edges) {
    if (!kept.has(e.from)) continue
    const edge = { ...e, to: representative(e.to) }
    const key = `${edge.from}|${edge.label}|${edge.to}`
    if (!seen.has(key)) edges.push(edge)
    seen.add(key)
  }
  const root = representative(raw.root)

  // Belt and braces: the labeled chart must decide exactly like the raw one.
  const behavior = compareBehavior(toGraph(raw.root, raw.nodes, raw.edges), toGraph(root, nodes, edges))
  if (!behavior.equivalent) {
    return { ok: false, errors: ['The merged chart no longer behaves like the code. Undo the merges.'] }
  }
  return { ok: true, nodes, edges, root }
}

/**
 * Turns a saved labeled flow back into the model's answer format, so
 * `vantle validate` can re-check it against the current raw flow.
 */
export function labelOutputFromFlow(flow: { nodes: LabeledNode[] }, ids: ShortIds): LabelOutput {
  const short = (id: string) => ids.toShort.get(id) ?? id
  return {
    boxes: flow.nodes.flatMap((n) =>
      n.kind === 'decision'
        ? [
            {
              ids: n.rawIds.map(short),
              label: n.label,
              category: n.category,
              rationale: n.rationale,
              caseLabels: Object.entries(n.caseLabels).map(([value, label]) => ({ value, label })),
            },
          ]
        : [],
    ),
    outcomes: flow.nodes.flatMap((n) => (n.kind === 'outcome' ? [{ id: short(n.id), label: n.label }] : [])),
    actions: flow.nodes.flatMap((n) => (n.kind === 'action' ? [{ id: short(n.id), label: n.label }] : [])),
  }
}

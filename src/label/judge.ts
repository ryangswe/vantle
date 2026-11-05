import { z } from 'zod'
import type { ExpectedFlow } from '../graph/expected.js'
import type { LabeledFlow } from '../schema/labeled.js'
import { normalizeCode } from '../util.js'
import type { Effort, StructuredModel } from './model.js'

export interface LabelPair {
  expectedKey: string
  expected: string
  generated: string
  code: string
}

/**
 * Pairs boxes in a labeled flow with boxes in a hand-written reference by
 * walking both charts from the start in step. Charts that behave the same and
 * have the same shape pair up one to one.
 */
export function pairLabels(expected: ExpectedFlow, flow: LabeledFlow): { pairs: LabelPair[]; unpaired: string[] } {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]))
  const out = new Map<string, Map<string, string>>()
  for (const e of flow.edges) {
    const m = out.get(e.from) ?? new Map<string, string>()
    m.set(normalizeCode(e.label), e.to)
    out.set(e.from, m)
  }

  const pairs: LabelPair[] = []
  const paired = new Map<string, string>()
  const queue: [string, string][] = [[expected.root, flow.root]]
  while (queue.length) {
    const [ek, start] = queue.shift()!
    if (paired.has(ek)) continue
    // Step boxes have no counterpart in a reference chart: walk past them.
    let fid = start
    for (let guard = 0; nodes.get(fid)?.kind === 'action' && guard < 50; guard++) fid = out.get(fid)?.get('next') ?? fid
    const en = expected.nodes[ek]
    const fn = nodes.get(fid)
    if (!en || !fn || fn.kind !== 'decision') continue
    paired.set(ek, fid)
    pairs.push({ expectedKey: ek, expected: en.label, generated: fn.label, code: fn.rawLabel })
    const edges = out.get(fid) ?? new Map()
    const next: [string, string][] =
      'test' in en
        ? [
            [en.yes, 'yes'],
            [en.no, 'no'],
          ]
        : Object.entries(en.cases).map(([value, to]) => [to, normalizeCode(value)] as [string, string])
    for (const [to, label] of next) {
      const target = edges.get(label)
      if (target) queue.push([to, target])
    }
  }
  const unpaired = Object.keys(expected.nodes).filter((k) => !paired.has(k))
  return { pairs, unpaired }
}

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      key: z.string(),
      /** 1 (wrong or unreadable) to 5 (as good as the reference). */
      score: z.number(),
      note: z.string(),
    }),
  ),
})

const JUDGE_SYSTEM = `You grade labels on a decision flowchart. Each box was labeled by a model, and a person wrote a reference label for the same box. The underlying code condition is given too.

Score each generated label from 1 to 5:
5 - as clear and accurate as the reference, or better
4 - accurate and readable, slightly worse wording
3 - accurate but awkward, too long, or too close to code
2 - partly wrong, or misleading in a way a reader would notice
1 - wrong, or unreadable to someone who doesn't read code

Accuracy against the code comes first. Product language and brevity come second. Wording can differ from the reference and still score 5. Give a short note for any score below 5.`

export interface JudgeResult {
  average: number
  verdicts: { key: string; expected: string; generated: string; score: number; note: string }[]
  unpaired: string[]
  costUsd: number | null
}

export async function judgeLabels(
  expected: ExpectedFlow,
  flow: LabeledFlow,
  model: StructuredModel,
  options: { model: string; effort: Effort },
): Promise<JudgeResult> {
  const { pairs, unpaired } = pairLabels(expected, flow)
  const prompt = [
    `Chart question: ${flow.flow.question}`,
    '',
    ...pairs.map((p) => `- key: ${p.expectedKey}\n  code: \`${p.code}\`\n  reference: ${p.expected}\n  generated: ${p.generated}`),
  ].join('\n')
  const response = await model({ system: JUDGE_SYSTEM, prompt, schema: Verdicts, model: options.model, effort: options.effort })
  if (!response.output) throw new Error("The judge's answer didn't match the required format.")
  const byKey = new Map(response.output.verdicts.map((v) => [v.key, v]))
  const verdicts = pairs.map((p) => {
    const v = byKey.get(p.expectedKey)
    return { key: p.expectedKey, expected: p.expected, generated: p.generated, score: v ? clamp(v.score) : 0, note: v?.note ?? 'not graded' }
  })
  const average = verdicts.length ? verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length : 0
  return { average: Math.round(average * 100) / 100, verdicts, unpaired, costUsd: response.costUsd }
}

function clamp(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)))
}

import { z } from 'zod'
import { ActionNode, Category, DecisionNode, OpaqueNode, OutcomeNode, RawFlow } from './flow.js'

/**
 * What the model returns when labeling a flow. It can only label and group boxes
 * that the extractor found, by their short IDs (n1, n2, … and o1, o2, …). Vantle
 * builds the labeled chart from this and checks it before using it.
 */
export const LabelOutput = z.object({
  boxes: z.array(
    z.object({
      /** One ID for a plain box. Two or more to merge boxes that make the same decision. */
      ids: z.array(z.string()),
      label: z.string(),
      category: Category,
      rationale: z.string(),
      /** Switch boxes only: a short label per case value. Empty for yes/no boxes. */
      caseLabels: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
  ),
  outcomes: z.array(z.object({ id: z.string(), label: z.string() })),
  /** Steps that set values (a1, a2, …), labeled as what they do: "Look up the sticky bucket". */
  actions: z.array(z.object({ id: z.string(), label: z.string() })),
})
export type LabelOutput = z.infer<typeof LabelOutput>

export const LabeledDecision = DecisionNode.extend({
  label: z.string(),
  category: Category,
  rationale: z.string(),
  /** Raw node IDs this box stands for. More than one when boxes were merged. */
  rawIds: z.array(z.string()),
  /** Switch boxes: case value as written in code → display label. */
  caseLabels: z.record(z.string(), z.string()),
})
export type LabeledDecision = z.infer<typeof LabeledDecision>

export const LabeledOutcome = OutcomeNode.extend({ label: z.string() })
export const LabeledOpaque = OpaqueNode.extend({ label: z.string() })
export const LabeledAction = ActionNode.extend({ label: z.string() })

export const LabeledNode = z.discriminatedUnion('kind', [LabeledDecision, LabeledOutcome, LabeledOpaque, LabeledAction])
export type LabeledNode = z.infer<typeof LabeledNode>

export const Labeling = z.object({
  model: z.string(),
  effort: z.string(),
  attempts: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Estimated from list prices; null when the model's price isn't known. */
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  labeledAt: z.string(),
})
export type Labeling = z.infer<typeof Labeling>

export const LabeledFlow = RawFlow.extend({
  nodes: z.array(LabeledNode),
  labeling: Labeling,
})
export type LabeledFlow = z.infer<typeof LabeledFlow>

/** Either kind of flow file, for code that only reads shared fields. */
export type AnyFlow = RawFlow | LabeledFlow

export function isLabeled(flow: AnyFlow): flow is LabeledFlow {
  return 'labeling' in flow
}

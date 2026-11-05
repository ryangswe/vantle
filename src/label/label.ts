import { enumeratePaths, toGraph } from '../graph/paths.js'
import type { VantleProject } from '../project.js'
import type { RawFlow } from '../schema/flow.js'
import { LabelOutput, type LabeledFlow } from '../schema/labeled.js'
import { DEFAULT_EFFORT, DEFAULT_MODEL, type Effort, type StructuredModel } from './model.js'
import { buildPrompt, collectSources, retryPrompt, SYSTEM_PROMPT } from './prompt.js'
import { shortIds, validateLabels } from './validate.js'

export interface LabelOptions {
  model?: string
  effort?: Effort
  /** Total tries, including the first. The spec allows one retry. */
  attempts?: number
}

export class LabelingFailed extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message)
  }
}

/** What would be sent to the model, without sending it. */
export function labelRequest(vp: VantleProject, raw: RawFlow) {
  const ids = shortIds(raw)
  const prompt = buildPrompt(raw, ids, collectSources(vp, raw))
  return { system: SYSTEM_PROMPT, prompt, ids }
}

/**
 * Labels a raw flow: asks the model for product-language labels, validates
 * them, and retries once with the validator's errors if needed.
 */
export async function labelFlow(vp: VantleProject, raw: RawFlow, model: StructuredModel, options: LabelOptions = {}): Promise<LabeledFlow> {
  const started = Date.now()
  const modelId = options.model ?? DEFAULT_MODEL
  const effort = options.effort ?? DEFAULT_EFFORT
  const maxAttempts = options.attempts ?? 2
  const { system, prompt, ids } = labelRequest(vp, raw)

  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | null = 0
  let answeredBy = modelId
  let currentPrompt = prompt
  let errors: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await model({ system, prompt: currentPrompt, schema: LabelOutput, model: modelId, effort })
    inputTokens += response.inputTokens
    outputTokens += response.outputTokens
    costUsd = costUsd === null || response.costUsd === null ? null : costUsd + response.costUsd
    answeredBy = response.model

    let previous: unknown = response.text
    if (response.output === null) {
      errors = ["The answer didn't match the required JSON format."]
    } else {
      previous = response.output
      const result = validateLabels(raw, response.output, ids)
      if (result.ok) {
        const graph = toGraph(result.root, result.nodes, result.edges)
        const all = enumeratePaths(graph, 100_000)
        const stored = all.paths.slice(0, raw.paths.length || 64)
        return {
          ...raw,
          root: result.root,
          nodes: result.nodes,
          edges: result.edges,
          paths: stored.map((p, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, steps: p.steps, outcome: p.outcome, status: 'unverified' as const })),
          pathCount: all.paths.length,
          pathsTruncated: all.paths.length > stored.length,
          labeling: {
            model: answeredBy,
            effort,
            attempts: attempt,
            inputTokens,
            outputTokens,
            costUsd,
            durationMs: Date.now() - started,
            labeledAt: new Date().toISOString(),
          },
        }
      }
      errors = result.errors
    }
    currentPrompt = retryPrompt(prompt, previous, errors)
  }

  throw new LabelingFailed(`Labels for ${raw.flow.slug} failed validation after ${maxAttempts} attempts.`, errors)
}

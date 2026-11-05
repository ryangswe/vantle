import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const DEFAULT_EFFORT: Effort = 'medium'
/**
 * Effort for writing path tests. On GrowthBook and the Slack fixture, low cost
 * about 30% less than medium and verified exactly the same paths.
 */
export const DEFAULT_TEST_EFFORT: Effort = 'low'

export interface ModelRequest<T> {
  system: string
  /**
   * Text that comes before the prompt and is the same across many requests,
   * such as source code. It's cached, so later requests read it cheaply.
   */
  prefix?: string
  prompt: string
  schema: z.ZodType<T>
  model: string
  effort: Effort
}

export interface ModelResponse<T> {
  /** Parsed output, or null when the model's answer didn't match the schema. */
  output: T | null
  /** The raw text, for retry prompts and debugging. */
  text: string
  /** Model that actually answered (differs from the request after a fallback). */
  model: string
  /** All input tokens, including those read from or written to the prompt cache. */
  inputTokens: number
  /** Input tokens read from the prompt cache. */
  cachedTokens: number
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number
  outputTokens: number
  costUsd: number | null
}

/** Anything that can answer a structured request. Tests pass a fake. */
export type StructuredModel = <T>(request: ModelRequest<T>) => Promise<ModelResponse<T>>

export class ModelRefusal extends Error {}
/** No credentials were found at all. */
export class MissingCredentials extends Error {}
/** Credentials were found but rejected, such as an invalid key or a federation rule that doesn't match. */
export class AuthFailed extends Error {}

/** Models that accept server-side fallbacks on refusal. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

/** List prices in USD per million tokens: input, output, cache read. */
const PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
}

export function estimateCost(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number | null {
  const price = PRICES[model]
  if (!price) return null
  const [i, o, c] = price
  return (input * i + cacheWrite * i * 1.25 + cacheRead * c + output * o) / 1_000_000
}

/**
 * Calls Claude with structured output. Credentials come from the environment
 * the usual way: ANTHROPIC_API_KEY, an `ant auth login` profile, or workload
 * identity federation in CI.
 */
export function anthropicModel(client?: Anthropic): StructuredModel {
  // One client per run: it caches the access token, so parallel requests share one
  // token exchange. (In CI, GitHub's identity tokens can only be exchanged once.)
  let shared = client
  return async <T>(request: ModelRequest<T>): Promise<ModelResponse<T>> => {
    let api: Anthropic
    try {
      api = shared ??= new Anthropic()
    } catch (error) {
      throw new MissingCredentials(error instanceof Error ? error.message : String(error))
    }
    let response
    try {
      response = await api.beta.messages.parse({
        model: request.model,
        max_tokens: 16_000,
        system: request.system,
        messages: [
          {
            role: 'user',
            content: request.prefix
              ? [
                  // The cache covers the system prompt and this block. Requests within
                  // five minutes of each other keep it alive.
                  { type: 'text', text: request.prefix, cache_control: { type: 'ephemeral' } },
                  { type: 'text', text: request.prompt },
                ]
              : request.prompt,
          },
        ],
        output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema as z.ZodType) },
        // If a safety classifier declines, retry on Anthropic's recommended fallback model.
        ...(FALLBACK_MODELS.has(request.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      })
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new AuthFailed(error.message)
      if (error instanceof Error && error.name === 'WorkloadIdentityError') throw new AuthFailed(error.message)
      // With no credentials at all, the SDK throws a plain Error when the request is built.
      if (!(error instanceof Anthropic.APIError) && error instanceof Error && /resolve authentication|api[_ -]?key|credentials/i.test(error.message)) {
        throw new MissingCredentials(error.message)
      }
      throw error
    }

    if (response.stop_reason === 'refusal') {
      throw new ModelRefusal(`The model declined to label this flow (${response.stop_details?.category ?? 'no category'}).`)
    }
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const usage = response.usage
    const input = usage.input_tokens
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    return {
      output: (response.parsed_output as T | null) ?? null,
      text,
      model: response.model,
      inputTokens: input + cacheRead + cacheWrite,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: usage.output_tokens,
      costUsd: estimateCost(response.model, input, usage.output_tokens, cacheRead, cacheWrite),
    }
  }
}

import { z } from 'zod'
import type { Effort, StructuredModel } from '../label/model.js'
import type { AnyFlow } from '../schema/labeled.js'
import type { TestContext } from './context.js'

/** One path a test should follow, in the short IDs shown to the writer. */
export interface PathSpec {
  id: string
  signature: string
  steps: { box: string; code: string; label?: string; answer: string; loop?: string }[]
  outcome: { box: string; value: string; label?: string }
}

/** A place in the code no path test ran, which a test should reach. */
export interface TargetSpec {
  id: string
  file: string
  line: number
  fn: string
  code: string
  /** What the code has to do, as a sentence: "run `return false`". */
  goal: string
}

export interface TestExample {
  code: string
  /** True when the code also followed the path the test was written for. */
  followed: boolean
}

export interface TestRequest {
  flow: AnyFlow
  context: TestContext
  /** All boxes, so the writer can reason about the whole chart. */
  boxes: { box: string; code: string; label?: string }[]
  paths: PathSpec[]
  /** Places in the code to reach, for checking the chart isn't missing branches. */
  targets?: TargetSpec[]
  /** A test for this function that ran without errors, to reuse its setup. */
  example?: TestExample
  /** Tests that broke last time, with their error, to fix instead of writing from scratch. */
  repairs?: { id: string; code: string; error: string }[]
}

export type TestAnswer =
  | { id: string; kind: 'test'; code: string }
  | { id: string; kind: 'impossible'; reason: string; conflict: { box: string; answer: string }[] }

export interface TestResponse {
  answers: TestAnswer[]
  inputTokens: number
  /** Input tokens read from the prompt cache. */
  cachedTokens?: number
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number
  outputTokens: number
  costUsd: number | null
}

/** Writes tests for a batch of paths. Tests pass a fake; real runs use Claude. */
export type TestWriter = (request: TestRequest) => Promise<TestResponse>

const Answer = z.object({
  paths: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['test', 'impossible']),
      /** Complete test file when kind is "test"; empty otherwise. */
      code: z.string(),
      /** One sentence when kind is "impossible"; empty otherwise. */
      reason: z.string(),
      /** Boxes and answers that can't all happen together; empty unless impossible. */
      conflict: z.array(z.object({ box: z.string(), answer: z.string() })),
    }),
  ),
})

export const HELPER_SPECIFIER = '../vantle'

export const TEST_SYSTEM_PROMPT = `You write Vitest tests that check a decision flowchart against real TypeScript code. A static analyzer extracted the chart from the code. For each path you're given, write a test whose inputs make the code take exactly that path.

Vantle instruments the code under test. Every box in the chart records the answer it actually gave, and Vantle checks the route and the outcome itself. Your only job is to set up inputs that drive the code down the path. Don't assert the outcome.

How to write each test:
- One complete test file per path. Vitest globals are on: use describe, it, expect and vi without importing them, and never import from "vitest".
- Import the function under test and any modules you need using the import paths given. Import the helper with: import { run } from '${HELPER_SPECIFIER}'
- Call the function under test exactly once, through run: const result = run(() => fn(...)). For an async function: await run(() => fn(...)). Don't call it any other way.
- Make every box on the path give exactly the listed answer, in order. Conditions are written in terms of the function's own parameters.
- Build the arguments directly when a condition depends only on them. When a condition reads a store, service, clock or another module, control it: vi.spyOn(exportedObject, 'method').mockReturnValue(...) for methods on exported objects, or vi.mock('<import path>', ...) for exported functions. Never mock the function under test, and don't mock a helper whose own checks appear as boxes in the chart: set up its inputs instead.
- For a box inside a loop, use a single item that gives the listed answer.
- Values for conditions that aren't on the path don't matter, but keep the inputs realistic.
- Write exactly one it(...) whose name starts with the path ID, for example it('p03: muted channel, not a followed thread', ...).
- Use only TypeScript that runs as written, with no placeholders.

When a path can't happen:
Sometimes the chart treats two checks as independent, but the code computes them from the same data, so a path's answers contradict each other. For example, "is a thread the user follows" = yes implies "is a thread message" = yes. If no inputs can produce a path, answer kind "impossible", explain why in one sentence, and list the boxes whose answers conflict (at least two, using the box IDs and the answers the path requires). Only do this when the contradiction comes from the code itself, not because mocking is inconvenient.

Code to reach:
Some requests also list places in the code that no path test ran, with IDs like r01. They check that the chart isn't missing a branch. For each one, write a test whose inputs make the code get there: the boxes can give any answers. The same rules apply: call the function through run() exactly once, and don't assert the outcome. Name the test with the ID, for example it('r01: invalid JSON', ...). If no input can make the code get there, because the code can't run (dead code) or only runs when called some other way, answer kind "impossible", give the reason in one sentence, and leave the conflict list empty.

Answer for every path and every place to reach you're given, using its ID.`

/**
 * The prompt in two parts. `shared` is the same for every request in a run
 * (the function, imports, boxes and source code), so it's cached and later
 * requests read it at a fraction of the price. `request` is this batch's work.
 */
export function testPrompt(request: TestRequest): { shared: string; request: string } {
  const { context, flow } = request
  const shared: string[] = []
  shared.push(`Chart question: ${flow.flow.question || '(none given)'}`)
  const call = context.entry.isMethod
    ? `\`${context.entry.name}\` (a method: create an instance of \`${context.entry.exportName ?? context.entry.name.split('.')[0]}\`)`
    : `\`${context.entry.name}\``
  shared.push(`Function under test: ${call} from '${context.entry.specifier}'${context.entry.exportName ? '' : ' (WARNING: not exported, so it may not be importable)'}`)
  shared.push(`It ${flow.flow.returnsBoolean ? 'returns a boolean' : 'returns a value'}.`)
  shared.push('', '## Import paths from a test file', '')
  for (const i of context.importPaths) shared.push(`- ${i.file}: '${i.specifier}'`)
  shared.push(`- Vantle helpers: '${HELPER_SPECIFIER}'`)
  shared.push('', '## Boxes in the chart', '')
  for (const b of request.boxes) shared.push(`- ${b.box}: \`${b.code}\`${b.label ? ` ("${b.label}")` : ''}`)
  shared.push('', '## Source code', '')
  if (context.truncated) shared.push('(Some files were left out to keep this short.)')
  for (const f of context.files) shared.push(`### ${f.file}`, '```ts', f.code.trim(), '```', '')

  const lines: string[] = []
  if (request.example) {
    lines.push(
      '## A test that works',
      '',
      `This test for another path ran the function without errors${request.example.followed ? ', and the code followed its path' : ''}. Reuse its setup (imports, mocks, and how it builds the inputs) and change only what each new test needs.`,
      '',
      '```ts',
      request.example.code.trim(),
      '```',
      '',
    )
  }
  if (request.paths.length) lines.push('## Paths to test', '')
  for (const p of request.paths) {
    lines.push(`### ${p.id}`)
    p.steps.forEach((s, i) =>
      lines.push(
        s.answer === 'next'
          ? `${i + 1}. (the code sets \`${s.code}\` here; nothing to choose)`
          : `${i + 1}. ${s.box} \`${s.code}\` → ${s.answer}${s.loop ? ` (inside \`${s.loop}\`: make one item give this answer)` : ''}`,
      ),
    )
    lines.push(`Outcome: ${p.outcome.box} \`${p.outcome.value}\`${p.outcome.label ? ` (${p.outcome.label})` : ''}`, '')
  }
  if (request.targets?.length) {
    lines.push('## Code to reach', '')
    for (const t of request.targets) lines.push(`### ${t.id}`, `In \`${t.fn}\` (${t.file}, line ${t.line}): ${t.goal}.`, '')
  }
  if (request.repairs?.length) {
    lines.push('## Tests to fix', '')
    lines.push(
      "These tests didn't work: they errored, didn't take their path, or didn't reach their code. Fix the test, not the code, keeping the same goal. Each problem says what went wrong.",
      '',
    )
    for (const r of request.repairs) lines.push(`### ${r.id}`, 'Error:', '```', r.error.slice(0, 3000), '```', 'Test:', '```ts', r.code, '```', '')
  }
  return { shared: shared.join('\n'), request: lines.join('\n') }
}

/** A test writer backed by Claude. */
export function claudeTestWriter(model: StructuredModel, options: { model: string; effort: Effort }): TestWriter {
  return async (request) => {
    const prompt = testPrompt(request)
    const response = await model({
      system: TEST_SYSTEM_PROMPT,
      prefix: prompt.shared,
      prompt: prompt.request,
      schema: Answer,
      model: options.model,
      effort: options.effort,
    })
    const answers: TestAnswer[] = (response.output?.paths ?? []).map((p) =>
      p.kind === 'impossible'
        ? { id: p.path, kind: 'impossible' as const, reason: p.reason, conflict: p.conflict }
        : { id: p.path, kind: 'test' as const, code: p.code },
    )
    return {
      answers,
      inputTokens: response.inputTokens,
      cachedTokens: response.cachedTokens,
      cacheWriteTokens: response.cacheWriteTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
    }
  }
}

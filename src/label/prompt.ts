import { Node } from 'ts-morph'
import { isFunctionLike } from '../extract/resolve.js'
import { functionName, relPath, type FunctionLike, type VantleProject } from '../project.js'
import type { RawFlow } from '../schema/flow.js'
import type { ShortIds } from './validate.js'

export interface SourceSnippet {
  file: string
  symbol: string
  startLine: number
  code: string
}

/** Source code of every function the flow passes through, in the order the chart first reaches them. */
export function collectSources(vp: VantleProject, flow: RawFlow): SourceSnippet[] {
  const wanted: { file: string; symbol: string; line: number }[] = []
  const seen = new Set<string>()
  for (const ref of [flow.flow.entry, ...flow.nodes.map((n) => n.source)]) {
    const key = `${ref.file}#${ref.symbol}`
    if (seen.has(key)) continue
    seen.add(key)
    wanted.push({ file: ref.file, symbol: ref.symbol, line: ref.line })
  }

  const snippets: SourceSnippet[] = []
  for (const w of wanted) {
    const file = vp.sourceFiles.find((f) => relPath(vp.root, f) === w.file)
    if (!file) continue
    let best: FunctionLike | undefined
    file.forEachDescendant((node) => {
      if (!isFunctionLike(node)) return
      if (node.getStartLineNumber() > w.line || node.getEndLineNumber() < w.line) return
      if (functionName(node) !== w.symbol) return
      // Prefer the innermost match.
      if (!best || node.getStart() >= best.getStart()) best = node
    })
    if (!best) continue
    const fn = best as FunctionLike
    // Include a leading comment block: it often explains intent.
    const holder = Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) ? fn.getParentOrThrow().getParentOrThrow() : fn
    const start = holder.getStartLineNumber(true)
    snippets.push({ file: w.file, symbol: w.symbol, startLine: start, code: holder.getFullText().trim() })
  }
  return snippets
}

export const SYSTEM_PROMPT = `You label decision flowcharts extracted from code so that people who don't read code (product managers, designers, support, new engineers) can understand them, in the style of Slack's well-known "Should we send a notification?" chart.

You receive a chart that a static analyzer extracted from TypeScript. Each box tests one condition, written as code. You write the label people will see. You cannot add, remove, or rewire boxes. The analyzer and a validator own the structure.

Labels:
- Write each yes/no box as a short question in product language, ideally 2 to 6 words: "Channel muted?", "User in Do Not Disturb?", "@here message?". Describe what the condition means for the user, not how the code computes it.
- Keep the domain's own terms (DnD, @mention, thread, workspace) when the code uses them.
- Prefer the words users see in the product over internal names: "@channel, @everyone or @here?" rather than "Broadcast mention?".
- Keep qualifiers that change the meaning, such as whose setting it is, which device, or which kind of mention: "User's pref for this device?", "Past the mobile push delay?". Shorter is better only when nothing is lost.
- For a switch box, write a "What is ...?" question, and give each case value a short label ("Nothing", "Everything").
- Stay faithful. Never claim more than the code does. If a condition is compound, the label must cover all of it ("Thread message the user follows?"). If you aren't sure what something means, stay closer to the code's own names rather than guessing.
- Boxes that test the same condition in different places should usually get the same label.
- A box inside a loop is checked once per item. If its answer leaves the loop early, say so: "Any prerequisite failing?".

Category (where the data comes from), one per box:
- pref: a user or workspace setting, feature flag, or config value
- state: runtime state read from a store or service (presence, DnD, subscriptions)
- input: the function's arguments or data parsed from the incoming request or message
- external: a call the analyzer couldn't look into, such as a third-party library or I/O
Each box has a guessed category ("hint"). Confirm it or change it.

Rationale: one sentence that quotes the code justifying the label.

Merging: list two or more IDs in one box only if they test exactly the same condition and lead to exactly the same places. A validator rejects anything else, so when in doubt, don't merge.

Outcomes: label each one briefly. When the chart answers a yes/no question, use "YES" and "NO".

Steps (a1, a2, …) set values instead of checking anything. Label each as what it does, in product language, without a question mark: "Use the user's sticky bucket", "No sticky bucket". Label every step exactly once under "actions".

Label every box and every outcome exactly once, using the IDs given.`

export function buildPrompt(flow: RawFlow, ids: ShortIds, sources: SourceSnippet[]): string {
  const short = (id: string) => ids.toShort.get(id) ?? id
  const lines: string[] = []
  lines.push(`Question: ${flow.flow.question || '(none given)'}`)
  lines.push(`Entry point: ${flow.flow.id}${flow.flow.returnsBoolean ? ' (returns a boolean: true means YES, false means NO)' : ''}`)
  lines.push('', '## Boxes', '')
  for (const node of flow.nodes) {
    if (node.kind !== 'decision') continue
    const out = flow.edges.filter((e) => e.from === node.id).map((e) => `${e.label} → ${short(e.to)}`).join(', ')
    lines.push(`${short(node.id)} [${node.branch === 'switch' ? 'switch' : 'yes/no'}] \`${node.rawLabel}\``)
    lines.push(`   hint: ${node.categoryHint} · ${node.source.file}:${node.source.line} in ${node.source.symbol}${node.loop ? ` · inside loop \`${node.loop}\`` : ''}`)
    lines.push(`   ${out}`)
  }
  const actions = flow.nodes.filter((n) => n.kind === 'action')
  if (actions.length) {
    lines.push('', '## Steps', '', 'These set values instead of checking anything. Vantle adds them where branches rejoin, so the checks after them are drawn once.', '')
    for (const node of actions) {
      const next = flow.edges.find((e) => e.from === node.id)
      lines.push(`${short(node.id)} sets \`${node.rawLabel}\` → ${next ? short(next.to) : '?'}`)
    }
  }
  lines.push('', '## Outcomes', '')
  for (const node of flow.nodes) {
    if (node.kind === 'outcome') lines.push(`${short(node.id)} \`${node.value}\``)
  }
  lines.push(`\nThe chart starts at ${short(flow.root)}.`)
  lines.push('', '## Source code', '')
  lines.push('Conditions above are rewritten in terms of the entry function\'s parameters, so helper parameter names may differ from the code below.')
  for (const s of sources) {
    lines.push('', `### ${s.file} · ${s.symbol} (line ${s.startLine})`, '```ts', s.code, '```')
  }
  return lines.join('\n')
}

export function retryPrompt(prompt: string, previous: unknown, errors: string[]): string {
  return [
    prompt,
    '',
    '## Your previous answer was rejected',
    '',
    'A validator found these problems. Fix them and answer again in full:',
    ...errors.map((e) => `- ${e}`),
    '',
    'Previous answer:',
    '```json',
    JSON.stringify(previous, null, 2),
    '```',
  ].join('\n')
}

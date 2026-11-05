import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadExpected } from '../src/graph/expected.js'
import { compareBehavior, toGraph } from '../src/graph/paths.js'
import { pairLabels } from '../src/label/judge.js'
import { labelFlow, LabelingFailed, labelRequest } from '../src/label/label.js'
import type { ModelRequest, ModelResponse, StructuredModel } from '../src/label/model.js'
import { labelOutputFromFlow, shortIds, validateLabels } from '../src/label/validate.js'
import { loadProject } from '../src/project.js'
import { toMermaid } from '../src/render/mermaid.js'
import type { RawFlow } from '../src/schema/flow.js'
import { LabeledFlow, type LabelOutput } from '../src/schema/labeled.js'
import { normalizeCode, shortHash } from '../src/util.js'
import { extract, FIXTURE, tempProject } from './helpers.js'

const raw = extract(FIXTURE)
const vp = loadProject(FIXTURE)

/** A complete, valid answer: one plain-language-ish label per box. */
function goodLabels(flow: RawFlow): LabelOutput {
  const ids = shortIds(flow)
  return {
    boxes: flow.nodes.flatMap((n) =>
      n.kind === 'decision'
        ? [
            {
              ids: [ids.toShort.get(n.id)!],
              label: `Label ${shortHash(n.rawLabel)}?`,
              category: n.categoryHint,
              rationale: `The code checks \`${n.rawLabel}\`.`,
              caseLabels:
                n.branch === 'switch'
                  ? flow.edges.filter((e) => e.from === n.id).map((e) => ({ value: e.label, label: e.label.replace(/'/g, '') }))
                  : [],
            },
          ]
        : [],
    ),
    outcomes: flow.nodes.flatMap((n) => (n.kind === 'outcome' ? [{ id: ids.toShort.get(n.id)!, label: n.value === 'true' ? 'YES' : 'NO' }] : [])),
    actions: flow.nodes.flatMap((n) => (n.kind === 'action' ? [{ id: ids.toShort.get(n.id)!, label: 'Set values' }] : [])),
  }
}

function idOf(flow: RawFlow, rawLabel: string, nth = 0): string {
  const ids = shortIds(flow)
  const matches = flow.nodes.filter((n) => n.kind === 'decision' && n.rawLabel === rawLabel)
  return ids.toShort.get(matches[nth]!.id)!
}

function errorsFor(output: LabelOutput, flow = raw): string[] {
  const result = validateLabels(flow, output)
  return result.ok ? [] : result.errors
}

describe('label validation', () => {
  it('accepts a complete answer and builds a chart that behaves like the code', () => {
    const result = validateLabels(raw, goodLabels(raw))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.nodes.filter((n) => n.kind === 'decision')).toHaveLength(26)
    const behavior = compareBehavior(toGraph(raw.root, raw.nodes, raw.edges), toGraph(result.root, result.nodes, result.edges))
    expect(behavior.equivalent).toBe(true)
  })

  it('rejects a box with no label', () => {
    const output = goodLabels(raw)
    const dropped = output.boxes.pop()!
    expect(errorsFor(output).join(' ')).toContain(`"${dropped.ids[0]}"`)
  })

  it('rejects invented IDs, duplicates, and outcomes listed as boxes', () => {
    const invented = goodLabels(raw)
    invented.boxes.push({ ids: ['n99'], label: 'Extra?', category: 'input', rationale: 'x', caseLabels: [] })
    expect(errorsFor(invented).join(' ')).toContain('"n99" is not a box')

    const duplicate = goodLabels(raw)
    duplicate.boxes.push({ ...duplicate.boxes[0]! })
    expect(errorsFor(duplicate).join(' ')).toContain('labeled more than once')

    const outcomeAsBox = goodLabels(raw)
    outcomeAsBox.boxes.push({ ids: ['o1'], label: 'Yes?', category: 'input', rationale: 'x', caseLabels: [] })
    expect(errorsFor(outcomeAsBox).join(' ')).toContain('is an outcome')
  })

  it('rejects missing outcomes, empty labels and labels that are too long', () => {
    const noOutcome = goodLabels(raw)
    noOutcome.outcomes.pop()
    expect(errorsFor(noOutcome).join(' ')).toMatch(/Outcome "o\d" .* has no label/)

    const empty = goodLabels(raw)
    empty.boxes[0]!.label = '  '
    expect(errorsFor(empty).join(' ')).toContain('is empty')

    const long = goodLabels(raw)
    long.boxes[0]!.label = 'x'.repeat(200)
    expect(errorsFor(long).join(' ')).toContain('longer than')
  })

  it('requires the same condition to have the same label everywhere', () => {
    const output = goodLabels(raw)
    // goodLabels gives every box its own label, so make the repeated conditions consistent first...
    const byCondition = new Map<string, string>()
    const ids = shortIds(raw)
    for (const box of output.boxes) {
      const node = raw.nodes.find((n) => n.id === ids.toFull.get(box.ids[0]!))!
      box.label = byCondition.get(node.rawLabel) ?? box.label
      byCondition.set(node.rawLabel, box.label)
    }
    expect(errorsFor(output)).toEqual([])
    // ...then give one of the three "Thread message?" boxes a different label.
    output.boxes.find((b) => b.ids[0] === idOf(raw, 'isThreadMessage(msg)', 1))!.label = 'Thread reply?'
    expect(errorsFor(output).join(' ')).toContain('`isThreadMessage(msg)` has different labels')
  })

  it('only allows case labels on switches, for cases that exist', () => {
    const onYesNo = goodLabels(raw)
    const muted = onYesNo.boxes.find((b) => b.ids[0] === idOf(raw, 'prefs.isChannelMuted(user.id, channel.id)'))!
    muted.caseLabels = [{ value: "'x'", label: 'X' }]
    expect(errorsFor(onYesNo).join(' ')).toContain("yes/no box, so it can't have case labels")

    const unknownCase = goodLabels(raw)
    const pref = unknownCase.boxes.find((b) => b.ids[0] === idOf(raw, 'prefs.channelPref(user.id, channel.id, device)'))!
    pref.caseLabels.push({ value: "'loud'", label: 'Loud' })
    expect(errorsFor(unknownCase).join(' ')).toContain("has no case 'loud'")
  })

  it('rejects merges of different conditions, or the same condition leading to different places', () => {
    const different = goodLabels(raw)
    const a = idOf(raw, 'dnd.isActive(user.id)')
    const b = idOf(raw, 'msg.dndOverride')
    different.boxes = different.boxes.filter((x) => x.ids[0] !== b)
    different.boxes.find((x) => x.ids[0] === a)!.ids.push(b)
    expect(errorsFor(different).join(' ')).toContain('test different conditions')

    // The fixture checks "Thread message?" in three places that continue differently.
    const samePlaces = goodLabels(raw)
    const first = idOf(raw, 'isThreadMessage(msg)', 0)
    const second = idOf(raw, 'isThreadMessage(msg)', 1)
    samePlaces.boxes = samePlaces.boxes.filter((x) => x.ids[0] !== second)
    samePlaces.boxes.find((x) => x.ids[0] === first)!.ids.push(second)
    expect(errorsFor(samePlaces).join(' ')).toContain('lead to different places')
  })

  it('merges boxes that make the same decision', () => {
    const flow = extract(
      tempProject({
        'main.ts': `
          // @vantle: "Q"
          export function q(a: boolean, b: boolean, c: boolean): boolean {
            if (c) {
              if (a) return true
            } else if (b) {
              if (a) return true
            }
            return false
          }`,
      }),
    )
    const output = goodLabels(flow)
    const first = idOf(flow, 'a', 0)
    const second = idOf(flow, 'a', 1)
    output.boxes = output.boxes.filter((x) => x.ids[0] !== second)
    output.boxes.find((x) => x.ids[0] === first)!.ids.push(second)
    const result = validateLabels(flow, output)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // c, b and two a's become c, b and one a.
    expect(flow.nodes.filter((n) => n.kind === 'decision')).toHaveLength(4)
    expect(result.nodes.filter((n) => n.kind === 'decision')).toHaveLength(3)
    expect(compareBehavior(toGraph(flow.root, flow.nodes, flow.edges), toGraph(result.root, result.nodes, result.edges)).equivalent).toBe(true)
  })

  it('re-validates a saved labeled flow', () => {
    const result = validateLabels(raw, goodLabels(raw))
    if (!result.ok) throw new Error('setup')
    const ids = shortIds(raw)
    expect(validateLabels(raw, labelOutputFromFlow({ nodes: result.nodes }, ids), ids).ok).toBe(true)
  })
})

/** A fake model that returns canned answers in order and records what it was asked. */
function fakeModel(answers: (LabelOutput | null)[]) {
  const requests: ModelRequest<unknown>[] = []
  const model: StructuredModel = async <T>(request: ModelRequest<T>): Promise<ModelResponse<T>> => {
    requests.push(request as ModelRequest<unknown>)
    const answer = answers.shift() ?? null
    return { output: answer as T | null, text: JSON.stringify(answer), model: request.model, inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 500, costUsd: 0.014 }
  }
  return { model, requests }
}

describe('labeling', () => {
  it('sends the chart and the source of every function it passes through', () => {
    const { prompt, system } = labelRequest(vp, raw)
    expect(system).toContain('You cannot add, remove, or rewire boxes')
    for (const fn of ['shouldNotify', 'wantsNotification', 'channelPrefAllows', 'mentionChecks', 'threadGate', 'deliverNow']) {
      expect(prompt).toContain(`· ${fn} (line`)
    }
    expect(prompt).toContain('n26 [yes/no] `prefs.isChannelMuted(user.id, channel.id)`')
    expect(prompt).toContain('if (presence.isActive(user.id)) return threadGate(msg, user)')
  })

  it('retries once with the validator errors, then succeeds', async () => {
    const bad = goodLabels(raw)
    bad.boxes.pop()
    const { model, requests } = fakeModel([bad, goodLabels(raw)])
    const labeled = await labelFlow(vp, raw, model, { model: 'claude-opus-5-5', effort: 'low' })
    expect(() => LabeledFlow.parse(labeled)).not.toThrow()
    expect(labeled.labeling).toMatchObject({ attempts: 2, inputTokens: 2000, outputTokens: 1000, model: 'claude-opus-5-5', effort: 'low' })
    expect(labeled.labeling.costUsd).toBeCloseTo(0.028)
    expect(requests[1]!.prompt).toContain('Your previous answer was rejected')
    expect(requests[1]!.prompt).toContain('has no label')
    expect(labeled.pathCount).toBe(raw.pathCount)
  })

  it('asks again when the answer is not valid JSON for the schema', async () => {
    const { model, requests } = fakeModel([null, goodLabels(raw)])
    const labeled = await labelFlow(vp, raw, model)
    expect(labeled.labeling.attempts).toBe(2)
    expect(requests[1]!.prompt).toContain("didn't match the required JSON format")
  })

  it('gives up after the allowed attempts', async () => {
    const bad = goodLabels(raw)
    bad.outcomes = []
    const { model } = fakeModel([bad, bad])
    await expect(labelFlow(vp, raw, model)).rejects.toBeInstanceOf(LabelingFailed)
  })

  it('renders labels and case labels instead of raw code', async () => {
    const output = goodLabels(raw)
    const pref = output.boxes.find((b) => b.ids[0] === idOf(raw, 'prefs.channelPref(user.id, channel.id, device)'))!
    pref.label = "User's channel notification pref?"
    pref.caseLabels = pref.caseLabels.map((c) => ({ ...c, label: c.value === "'nothing'" ? 'Nothing' : c.value === "'default'" ? 'Default (use global)' : c.label }))
    const { model } = fakeModel([output])
    const mmd = toMermaid(await labelFlow(vp, raw, model))
    expect(mmd).toContain("User's channel notification pref?")
    expect(mmd).toContain('-->|"Nothing"|')
    expect(mmd).toContain('-->|"Default (use global)"|')
    expect(mmd).not.toContain('prefs.isChannelMuted')
  })
})

describe('label judge pairing', () => {
  it('pairs every generated box with its reference box', async () => {
    const { model } = fakeModel([goodLabels(raw)])
    const labeled = await labelFlow(vp, raw, model)
    const expected = loadExpected(path.join(FIXTURE, 'expected.json'))
    const { pairs, unpaired } = pairLabels(expected, labeled)
    expect(unpaired).toEqual([])
    expect(pairs).toHaveLength(26)
    for (const p of pairs) {
      const node = expected.nodes[p.expectedKey]!
      const code = 'test' in node ? node.test : node.switch
      expect(normalizeCode(p.code)).toBe(normalizeCode(code))
    }
  })
})

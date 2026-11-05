import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectedToGraph, loadExpected } from '../src/graph/expected.js'
import { compareBehavior, toGraph } from '../src/graph/paths.js'
import { loadProject } from '../src/project.js'
import { scan } from '../src/scan.js'
import type { RawFlow } from '../src/schema/flow.js'
import { RawFlow as RawFlowSchema } from '../src/schema/flow.js'
import { copyFixture, editFile, extract, FIXTURE } from './helpers.js'

const expected = loadExpected(path.join(FIXTURE, 'expected.json'))
const graphOf = (flow: RawFlow) => toGraph(flow.root, flow.nodes, flow.edges)

describe('Slack notification fixture (M1)', () => {
  const flow = extract(FIXTURE)

  it('produces a valid raw flow', () => {
    expect(() => RawFlowSchema.parse(flow)).not.toThrow()
    expect(flow.flow.id).toBe('src/notify.ts#shouldNotify')
    expect(flow.flow.question).toBe('Should we send a notification?')
    expect(flow.flow.returnsBoolean).toBe(true)
    expect(flow.warnings).toEqual([])
  })

  it('behaves the same as the hand-written chart for every input', () => {
    const result = compareBehavior(expectedToGraph(expected), graphOf(flow))
    expect(result.counterexamples).toEqual([])
    expect(result.onlyInExpected).toEqual([])
    expect(result.onlyInActual).toEqual([])
    expect(result.equivalent).toBe(true)
  })

  it('has one box per decision in the reference chart', () => {
    const decisions = flow.nodes.filter((n) => n.kind === 'decision')
    expect(decisions).toHaveLength(Object.keys(expected.nodes).length)
    expect(flow.nodes.filter((n) => n.kind === 'outcome').map((n) => n.rawLabel).sort()).toEqual(['false', 'true'])
  })

  it('rewrites helper parameters back to the entry function arguments', () => {
    const labels = flow.nodes.map((n) => n.rawLabel)
    // modes.ts names its parameters m, u, ch, dev; the chart should not.
    expect(labels).toContain('prefs.channelPref(user.id, channel.id, device)')
    expect(labels.some((l) => /\b(m|u|ch|dev)\b/.test(l))).toBe(false)
  })

  it('guesses legend categories from what each condition reads', () => {
    const hint = (label: string) => flow.nodes.find((n) => n.kind === 'decision' && n.rawLabel === label)
    expect(hint('prefs.isChannelMuted(user.id, channel.id)')).toMatchObject({ categoryHint: 'pref' })
    expect(hint('dnd.isActive(user.id)')).toMatchObject({ categoryHint: 'state' })
    expect(hint('isBroadcastMention(msg)')).toMatchObject({ categoryHint: 'input' })
  })

  it('records where each box comes from', () => {
    const muted = flow.nodes.find((n) => n.rawLabel === 'prefs.isChannelMuted(user.id, channel.id)')
    expect(muted?.source).toMatchObject({ file: 'src/notify.ts', module: 'src', symbol: 'wantsNotification' })
    const globalPref = flow.nodes.find((n) => n.rawLabel === 'prefs.globalPref(user.id, device)')
    expect(globalPref?.source).toMatchObject({ file: 'src/modes.ts', symbol: 'globalPrefAllows' })
  })

  it('ranks the marked entry point first in scan', () => {
    const rows = scan(loadProject(FIXTURE))
    expect(rows[0]).toMatchObject({ name: 'shouldNotify', marked: true })
  })
})

describe('scoring catches mistakes', () => {
  it('flags a reference chart with one wrong arrow', () => {
    const broken = structuredClone(expected)
    const node = broken.nodes.presence
    if (!node || !('test' in node)) throw new Error('fixture changed')
    node.no = 'NO' // the code falls through to the highlight-word check instead
    const result = compareBehavior(expectedToGraph(broken), graphOf(extract(FIXTURE)))
    expect(result.equivalent).toBe(false)
    expect(result.counterexamples[0]?.inputs['presence.isActive(user.id)']).toBe('false')
  })

  it('flags code that changes one return value', () => {
    const dir = copyFixture()
    editFile(path.join(dir, 'src/modes.ts'), (t) => t.replace("case 'never':\n      return false", "case 'never':\n      return true"))
    const result = compareBehavior(expectedToGraph(expected), graphOf(extract(dir)))
    expect(result.equivalent).toBe(false)
    expect(result.counterexamples[0]?.inputs['prefs.globalPref(user.id, device)']).toBe("'never'")
  })

  it('flags code that drops a check', () => {
    const dir = copyFixture()
    editFile(path.join(dir, 'src/notify.ts'), (t) => t.replace('if (!msg.dndOverride) return false', ''))
    const result = compareBehavior(expectedToGraph(expected), graphOf(extract(dir)))
    expect(result.equivalent).toBe(false)
    expect(result.onlyInExpected).toContain('msg.dndOverride')
  })
})

describe('stable node IDs', () => {
  it('keep their IDs when code elsewhere in the file changes', () => {
    const before = extract(FIXTURE)
    const dir = copyFixture()
    editFile(path.join(dir, 'src/notify.ts'), (t) =>
      t.replace('// @vantle:', 'export function unrelated(n: number): number {\n  if (n > 1) return n\n  return 0\n}\n\n// @vantle:'),
    )
    editFile(path.join(dir, 'src/modes.ts'), (t) => `// A comment that moves every line down.\n\n${t}`)
    const after = extract(dir)
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort())
    expect(after.flow.sourceHash).not.toBe(before.flow.sourceHash)
  })
})

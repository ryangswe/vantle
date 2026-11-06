import { describe, expect, it } from 'vitest'
import { toMarkdown } from '../src/render/mermaid.js'
import { toSvg, wrap } from '../src/render/svg.js'
import type { RawFlow } from '../src/schema/flow.js'
import type { LabeledFlow, LabeledNode } from '../src/schema/labeled.js'
import { normalizeCode } from '../src/util.js'
import { extract, FIXTURE, tempProject } from './helpers.js'

type Rect = { x: number; y: number; w: number; h: number }

/** Arrows leave from a port 1px wide, just outside the box. */
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1.5)

/** Each box's rectangle, by its index in the flow. */
function boxes(svg: string): Map<number, Rect> {
  const out = new Map<number, Rect>()
  for (const m of svg.matchAll(/<rect class="box [^"]*" data-box="(\d+)" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    out.set(Number(m[1]), { x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) })
  }
  return out
}

/** Where each arrow starts, by its index in the flow. */
function arrowStarts(svg: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  for (const m of svg.matchAll(/<path class="arr" data-edge="([^"]+)" d="M([\d.-]+),([\d.-]+)/g)) {
    out.set(m[1]!, { x: Number(m[2]), y: Number(m[3]) })
  }
  return out
}

/**
 * Arrows that run through another arrow's label. Each label's background follows its own
 * arrow in the SVG, so labels are matched to arrows by order.
 */
function labelsCrossed(svg: string): string[] {
  const paths: { edge: string; pts: { x: number; y: number }[] }[] = []
  const labels: { edge: string; x: number; y: number; w: number; h: number }[] = []
  let current = ''
  for (const m of svg.matchAll(/<path class="arr" data-edge="([^"]+)" d="([^"]+)"|<rect class="lblbg" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    if (m[1]) {
      current = m[1]
      paths.push({ edge: m[1], pts: [...m[2]!.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) })) })
    } else labels.push({ edge: current, x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]) })
  }
  const crossed: string[] = []
  for (const l of labels) {
    for (const p of paths) {
      if (p.edge === l.edge) continue
      const hits = p.pts.slice(1).some((b, k) => {
        const a = p.pts[k]!
        for (let t = 0; t <= 1; t += 0.05) {
          const x = a.x + (b.x - a.x) * t
          const y = a.y + (b.y - a.y) * t
          if (x > l.x + 1 && x < l.x + l.w - 1 && y > l.y + 1 && y < l.y + l.h - 1) return true
        }
        return false
      })
      if (hits) crossed.push(`arrow ${p.edge} crosses the label of arrow ${l.edge}`)
    }
  }
  return crossed
}

/** Gives every node a label, as `vantle label` would, without calling a model. */
function labelByHand(flow: RawFlow, labels: Record<string, string>, caseLabels: Record<string, string> = {}): LabeledFlow {
  const nodes: LabeledNode[] = flow.nodes.map((n) => {
    if (n.kind === 'decision') {
      const cases = Object.fromEntries(
        flow.edges.filter((e) => e.from === n.id && n.branch === 'switch').map((e) => [normalizeCode(e.label), caseLabels[e.label] ?? e.label]),
      )
      return { ...n, label: labels[n.rawLabel] ?? `${n.rawLabel}?`, category: n.categoryHint, rationale: '', rawIds: [n.id], caseLabels: cases }
    }
    if (n.kind === 'outcome') return { ...n, label: n.value === 'true' ? 'YES' : n.value === 'false' ? 'NO' : n.value }
    return { ...n, label: n.rawLabel }
  })
  const labeling = { model: 'by-hand', effort: 'low', attempts: 1, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0, labeledAt: '2026-01-01T00:00:00Z' }
  return { ...flow, nodes, labeling }
}

describe('svg chart', () => {
  const flow = extract(FIXTURE)

  it('draws every box, and gives each arrow into an outcome its own end', async () => {
    const svg = await toSvg(flow)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('<title id="vantle-should-notify-title">Should we send a notification?</title>')
    const decisions = flow.nodes.flatMap((n, i) => (n.kind === 'decision' ? [i] : []))
    expect([...boxes(svg).keys()].sort((a, b) => a - b)).toEqual(decisions)
    const intoOutcomes = flow.edges.filter((e) => flow.nodes.find((n) => n.id === e.to)?.kind === 'outcome').length
    expect(svg.match(/data-end="/g)).toHaveLength(intoOutcomes)
    expect(intoOutcomes).toBeGreaterThan(2)
  })

  it('sends "yes" out of the bottom of a box and "no" out of its right side', async () => {
    const svg = await toSvg(flow)
    const rects = boxes(svg)
    const starts = arrowStarts(svg)
    let checked = 0
    flow.edges.forEach((e, i) => {
      if (e.label !== 'yes' && e.label !== 'no') return
      const box = rects.get(flow.nodes.findIndex((n) => n.id === e.from))!
      const start = starts.get(String(i))!
      if (e.label === 'yes') {
        near(start.y, box.y + box.h)
        expect(start.x).toBeGreaterThan(box.x)
        expect(start.x).toBeLessThan(box.x + box.w)
      } else {
        near(start.x, box.x + box.w)
        expect(start.y).toBeGreaterThan(box.y)
        expect(start.y).toBeLessThan(box.y + box.h)
      }
      checked++
    })
    expect(checked).toBeGreaterThan(40)
  })

  it('fans the cases of a switch out along its bottom edge, in order', async () => {
    const svg = await toSvg(flow)
    const rects = boxes(svg)
    const starts = arrowStarts(svg)
    const switches = flow.nodes.flatMap((n, i) => (n.kind === 'decision' && n.branch === 'switch' ? [[n, i] as const] : []))
    expect(switches.length).toBeGreaterThan(0)
    for (const [node, index] of switches) {
      const box = rects.get(index)!
      const xs = flow.edges.flatMap((e, i) => (e.from === node.id ? [starts.get(String(i))!] : [])).map((start) => {
        near(start.y, box.y + box.h)
        return start.x
      })
      expect(xs).toEqual([...xs].sort((a, b) => a - b))
      expect(new Set(xs).size).toBe(xs.length)
    }
  })

  it('keeps every arrow clear of the other arrows\' labels', async () => {
    const svg = await toSvg(flow)
    expect(svg.match(/class="lblbg"/g)!.length).toBeGreaterThan(50)
    expect(labelsCrossed(svg)).toEqual([])
  })

  it('is self-contained, with a dark theme', async () => {
    const svg = await toSvg(flow)
    expect(svg).toContain('@media (prefers-color-scheme: dark)')
    expect(svg).not.toMatch(/href|@import|url\(/)
  })

  it('cuts long case names, and drops characters XML does not allow', async () => {
    const dir = tempProject({
      'mode.ts': [
        '// @vantle: "Which <mode> & why?"',
        'export function mode(m: string): boolean {',
        '  switch (m) {',
        "    case 'a-very-long-case-name-that-keeps-going-and-going':",
        '      return true',
        "    case 'b\u0001':",
        '      return false',
        '    default:',
        '      return true',
        '  }',
        '}',
      ].join('\n'),
    })
    const svg = await toSvg(extract(dir))
    expect(svg).toContain('>Which &lt;mode&gt; &amp; why?</title>')
    expect(svg).toContain(">'a-very-long-case-name-that…</text>")
    expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
  })

  it('shows raw code in a code font, and escapes it', async () => {
    const svg = await toSvg(flow)
    expect(svg).toContain(`class="tc"`)
    expect(svg).toContain(">device === 'mobile'?</text>")
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)
    for (const text of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(text[1]).not.toMatch(/^\?$/)
  })

  it('uses labels and case names in a labeled chart, with a legend for the colours it uses', async () => {
    const labeled = labelByHand(
      flow,
      { 'prefs.channelPref(user.id, channel.id, device)': "What is the user's channel pref for this device?" },
      { "'default'": 'Default (use global)' },
    )
    const svg = await toSvg(labeled)
    expect(svg).toContain('channel pref for this')
    expect(svg).toContain('>Default (use global)</text>')
    expect(svg).not.toContain(`class="tc"`)
    const used = new Set(labeled.nodes.flatMap((n) => (n.kind === 'decision' ? [n.category] : [])))
    for (const [cls, text] of [['pref', 'A setting, flag or config'], ['state', 'Live state'], ['input', 'The arguments or request'], ['external', "A call Vantle couldn't look into"]]) {
      expect(svg.includes(`>${text}</text>`)).toBe(used.has(cls as never))
    }
    expect(svg).not.toContain('A step that sets values')
  })

  it('draws steps, outcomes that are not yes or no, and code it does not look inside', async () => {
    const dir = tempProject({
      'pick.ts': [
        '// @vantle: "Which plan?"',
        'export function pick(trial: boolean, seats: number, legacy: boolean, beta: boolean, frozen: boolean): string {',
        "  let tier = 'basic'",
        "  if (trial) tier = 'trial'",
        "  if (legacy) return 'legacy'",
        "  if (seats > 50) return 'enterprise'",
        "  if (beta) return 'beta'",
        "  if (frozen) return 'frozen'",
        "  if (tier === 'basic') return 'basic'",
        "  return 'trial'",
        '}',
      ].join('\n'),
    })
    const raw = extract(dir)
    expect(raw.nodes.some((n) => n.kind === 'action')).toBe(true)
    // The extractor doesn't make "not looked inside" boxes today, but the format allows them.
    const first = raw.nodes.find((n) => n.id === raw.root)!
    const withOpaque: RawFlow = {
      ...raw,
      root: 'loop',
      nodes: [...raw.nodes, { id: 'loop', kind: 'opaque', rawLabel: 'for (const s of seatsList) { … }', source: first.source }],
      edges: [...raw.edges, { from: 'loop', to: raw.root, label: 'next' }],
    }
    const svg = await toSvg(withOpaque)
    expect(svg).toContain('class="box action"')
    expect(svg).toContain('class="box opaque"')
    expect(svg).toContain('class="out" data-end=')
    expect(svg).toContain(`class="tout tcode"`)
    expect(svg).toContain('A step that sets values')
    expect(svg).toContain("Code Vantle doesn't look inside yet")
    expect(svg).toMatch(/Every path ends in one of \d+ outcomes\./)
    // A "next" arrow has no label.
    expect(svg).not.toContain('>next</text>')
  })

  it('draws a chart with no decisions', async () => {
    const dir = tempProject({ 'k.ts': '// @vantle: "Always?"\nexport function k(): boolean {\n  return true\n}\n' })
    const svg = await toSvg(extract(dir))
    expect(svg.match(/data-end="/g)).toHaveLength(1)
    expect(svg).toContain('data-end="start"')
    expect(svg).toContain('Every path ends in YES or NO.')
  })

  it('gives the same SVG for the same chart', async () => {
    expect(await toSvg(flow)).toBe(await toSvg(flow))
  })

  it('is shown on the markdown page, with the Mermaid chart folded below it', () => {
    const md = toMarkdown(flow)
    expect(md).toContain('![Chart of Should we send a notification?](./should-notify.svg)')
    expect(md.indexOf('./should-notify.svg')).toBeLessThan(md.indexOf('```mermaid'))
    expect(md).toContain('<details><summary>The same chart in Mermaid</summary>')
    expect(toMarkdown({ ...flow, flow: { ...flow.flow, question: 'Is it in [beta?' } })).toContain('![Chart of Is it in \\[beta?](./should-notify.svg)')
  })

  it('can leave the SVG off the markdown page', () => {
    const md = toMarkdown(flow, { svg: false })
    expect(md).not.toContain('.svg')
    expect(md).not.toContain('<details>')
    expect(md).toContain('```mermaid\nflowchart TD')
  })
})

describe('wrap', () => {
  it('breaks text into lines no longer than the limit', () => {
    expect(wrap('is the user in do not disturb', 12)).toEqual(['is the user', 'in do not', 'disturb'])
  })

  it('splits a word longer than a line', () => {
    expect(wrap('this.config.rewriteRequestPath x', 10)).toEqual(['this.confi', 'g.rewriteR', 'equestPath', 'x'])
  })

  it('keeps one empty line for empty text', () => {
    expect(wrap('', 10)).toEqual([''])
  })
})

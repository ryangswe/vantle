import elk from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPoint, ElkPort } from 'elkjs/lib/elk-api.js'
import type { Category, FlowNode } from '../schema/flow.js'
import { isLabeled, type AnyFlow, type LabeledNode } from '../schema/labeled.js'
import { edgeLabel } from './mermaid.js'

type AnyNode = FlowNode | LabeledNode

// elkjs is CommonJS, but its typings describe an ES module with a default export. The
// module's own `default` property is the constructor, so this works both ways.
const ELK = elk.default

// Text sizes. Widths are estimated from character counts, since there is no font to measure with.
const LINE = 17
const PADX = 12
const PADY = 10
const SANS_CHAR = 7.0 // 13px sans-serif
const CODE_CHAR = 7.3 // 12px monospace, for boxes that show raw code
const LABEL_CHAR = 6.6 // 11px monospace, for arrow labels
const END_LINE = 15
/** Long raw conditions are cut after this many lines. The .md page lists the full code. */
const MAX_LINES = 8
/** Switch case labels longer than this are cut, so one long case can't make its box very wide. */
const MAX_CASE = 28

/** What each colour in the legend means, in the order it's shown. */
const LEGEND: { cls: Category | 'action' | 'opaque'; text: string }[] = [
  { cls: 'pref', text: 'A setting, flag or config' },
  { cls: 'state', text: 'Live state' },
  { cls: 'input', text: 'The arguments or request' },
  { cls: 'external', text: "A call Vantle couldn't look into" },
  { cls: 'action', text: 'A step that sets values' },
  { cls: 'opaque', text: "Code Vantle doesn't look inside yet" },
]

type Meta =
  | { kind: 'start'; lines: string[] }
  | { kind: 'box'; cls: string; code: boolean; lines: string[] }
  | { kind: 'end'; cls: 'yes' | 'no' | 'out'; code: boolean; lines: string[] }

/**
 * Draws a flow as a standalone SVG. ELK lays out the boxes and routes the arrows at right
 * angles. "Yes" always leaves a box from the bottom and "no" from the right, and each case
 * of a multi-way check leaves from its own slot on the bottom edge. Every arrow into an
 * outcome gets its own small end, as in Slack's published chart, so no arrow has to cross
 * the page to reach one shared end. The SVG has light and dark themes.
 */
export async function toSvg(flow: AnyFlow): Promise<string> {
  const labeled = isLabeled(flow)
  const nodes: AnyNode[] = flow.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children: ElkNode[] = []
  const edges: ElkExtendedEdge[] = []
  const meta = new Map<string, Meta>()

  const outEdges = new Map<string, [(typeof flow.edges)[number], number][]>()
  flow.edges.forEach((e, i) => {
    if (!byId.has(e.from) || !byId.has(e.to)) throw new Error(`Arrow ${e.from} → ${e.to} points at a box that isn't in the chart.`)
    outEdges.set(e.from, [...(outEdges.get(e.from) ?? []), [e, i]])
  })

  // An arrow into an outcome ends at a small end of its own. Any other arrow ends at the
  // top of its box.
  const target = (to: string, key: string): string => {
    const node = byId.get(to)
    if (!node) throw new Error(`The chart has no box ${to}.`)
    if (node.kind !== 'outcome') return `in-${to}`
    const id = `end-${key}`
    const end = endOf(node, flow.flow.returnsBoolean)
    const width = Math.max(44, Math.max(...end.lines.map((l) => l.length)) * LABEL_CHAR + 20)
    children.push({ id, width, height: end.lines.length * END_LINE + 9 })
    meta.set(id, { kind: 'end', ...end })
    return id
  }

  const question = flow.flow.question || flow.flow.id
  const startLines = wrap(question, 30)
  children.push({ id: 'start', width: widest(startLines, SANS_CHAR) + 36, height: startLines.length * LINE + 2 * PADY })
  meta.set('start', { kind: 'start', lines: startLines })
  edges.push({ id: 'e-start', sources: ['start'], targets: [target(flow.root, 'start')] })

  for (const node of nodes) {
    if (node.kind === 'outcome') continue
    const label = 'label' in node ? node.label : undefined
    const code = label === undefined
    const lines = clip(wrap(label ?? node.rawLabel, code ? 30 : 24))
    // A raw condition reads as a question. The "?" goes on its last line, never on a line of its own.
    if (code && node.kind === 'decision') lines[lines.length - 1] += '?'
    const height = lines.length * LINE + 2 * PADY
    let width = widest(lines, code ? CODE_CHAR : SANS_CHAR) + 2 * PADX
    const outs = outEdges.get(node.id) ?? []
    let ports: ElkPort[]
    let constraint: 'FIXED_POS' | 'FIXED_SIDE'

    if (node.kind === 'decision' && node.branch === 'switch') {
      // A switch fans out along its bottom edge. Each case gets a slot wide enough for its
      // label, so no label sits across a neighbouring arrow.
      const slots = outs.map(([e]) => arrowText(node, e.label).length * LABEL_CHAR + 24)
      const total = slots.reduce((a, b) => a + b, 0)
      width = Math.max(width, total)
      let x = (width - total) / 2
      ports = outs.map(([, i], k) => {
        const port = { id: `p${i}`, width: 1, height: 1, x: x + 6, y: height, layoutOptions: { 'elk.port.side': 'SOUTH' } }
        x += slots[k]!
        return port
      })
      ports.push({ id: `in-${node.id}`, width: 1, height: 1, x: width / 2, y: 0, layoutOptions: { 'elk.port.side': 'NORTH' } })
      constraint = 'FIXED_POS'
    } else {
      ports = outs.map(([e, i], k) => ({
        id: `p${i}`,
        width: 1,
        height: 1,
        layoutOptions: { 'elk.port.side': e.label === 'no' ? 'EAST' : 'SOUTH', 'elk.port.index': String(k) },
      }))
      ports.push({ id: `in-${node.id}`, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'NORTH' } })
      constraint = 'FIXED_SIDE'
    }
    children.push({ id: node.id, ports, layoutOptions: { 'elk.portConstraints': constraint }, width, height })
    meta.set(node.id, { kind: 'box', cls: boxClass(node), code, lines })
  }

  flow.edges.forEach((e, i) => {
    const text = arrowText(byId.get(e.from), e.label)
    edges.push({
      id: `e${i}`,
      sources: [`p${i}`],
      targets: [target(e.to, String(i))],
      labels: text
        ? [{ text, width: text.length * LABEL_CHAR + 8, height: 16, layoutOptions: { 'elk.edgeLabels.placement': 'TAIL' } }]
        : [],
    })
  })

  const out = await new ELK().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      // The most compact of the placements tried. NETWORK_SIMPLEX drifts into a staircase.
      'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.spacing.nodeNode': '26',
      'elk.layered.spacing.nodeNodeBetweenLayers': '34',
      'elk.spacing.edgeNode': '14',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '14',
      'elk.spacing.edgeLabel': '3',
      'elk.layered.mergeEdges': 'true',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children,
    edges,
  })

  // Arrows, boxes and ends carry their index in the flow (`data-edge`, `data-box`, and
  // `data-end` for the arrow an end belongs to), so a reader or test can match them up.
  const boxIndex = new Map(nodes.map((node, i) => [node.id, i]))
  const body: string[] = []
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const edge = e.id === 'e-start' ? 'start' : e.id.slice(1)
    for (const s of e.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]
      const last = pts[pts.length - 1]!
      const prev = pts[pts.length - 2]!
      const angle = Math.atan2(last.y - prev.y, last.x - prev.x)
      // Stop the line short of the arrowhead.
      pts[pts.length - 1] = { x: last.x - Math.cos(angle) * 6, y: last.y - Math.sin(angle) * 6 }
      body.push(`<path class="arr" data-edge="${edge}" d="${roundedPath(pts)}"/>`)
      const a1 = angle + Math.PI * 0.82
      const a2 = angle - Math.PI * 0.82
      body.push(
        `<path class="ah" d="M${n(last.x)},${n(last.y)} L${n(last.x + Math.cos(a1) * 7)},${n(last.y + Math.sin(a1) * 7)} L${n(last.x + Math.cos(a2) * 7)},${n(last.y + Math.sin(a2) * 7)} Z"/>`,
      )
    }
    for (const l of e.labels ?? []) {
      if (!l.text) continue
      const x = l.x ?? 0
      const y = l.y ?? 0
      const w = l.width ?? 0
      body.push(`<rect class="lblbg" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(l.height ?? 16)}" rx="3"/>`)
      body.push(`<text class="lbl" x="${n(x + w / 2)}" y="${n(y + 12)}" text-anchor="middle">${esc(l.text)}</text>`)
    }
  }

  for (const c of out.children ?? []) {
    const m = meta.get(c.id)!
    const x = c.x ?? 0
    const y = c.y ?? 0
    const w = c.width ?? 0
    const h = c.height ?? 0
    const cx = n(x + w / 2)
    if (m.kind === 'end') {
      body.push(`<rect class="${m.cls}" data-end="${c.id.slice('end-'.length)}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12"/>`)
      const textClass = `t${m.cls}${m.code ? ' tcode' : ''}`
      m.lines.forEach((line, i) => body.push(`<text class="${textClass}" x="${cx}" y="${n(y + 16 + i * END_LINE)}" text-anchor="middle">${esc(line)}</text>`))
      continue
    }
    const start = m.kind === 'start'
    const box = start ? '' : ` data-box="${boxIndex.get(c.id)}"`
    body.push(`<rect class="box ${start ? 'start' : m.cls}"${box} x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${start ? n(h / 2) : 6}"/>`)
    const textClass = start ? 'tstart' : m.code ? 'tc' : 't'
    m.lines.forEach((line, i) => {
      body.push(`<text class="${textClass}" x="${cx}" y="${n(y + PADY + 13 + i * LINE)}" text-anchor="middle">${esc(line)}</text>`)
    })
  }

  // The legend lists only the colours this chart uses, in rows above it.
  const used = new Set([...meta.values()].flatMap((m) => (m.kind === 'box' ? [m.cls] : [])))
  const width = Math.max(out.width ?? 0, 360)
  const items = LEGEND.filter((l) => used.has(l.cls)).map((l) => ({ ...l, width: 20 + l.text.length * 6.1 + 26 }))
  const rows: (typeof items)[] = []
  for (const item of items) {
    const row = rows[rows.length - 1]
    if (row && row.reduce((a, b) => a + b.width, 0) + item.width <= width) row.push(item)
    else rows.push([item])
  }
  const head = rows.length ? rows.length * 22 + 24 : 0
  const legend: string[] = []
  rows.forEach((row, r) => {
    let lx = 0
    const ly = -head + 6 + r * 22
    for (const item of row) {
      legend.push(`<rect class="box ${item.cls}" x="${lx}" y="${ly}" width="14" height="14" rx="3"/>`)
      legend.push(`<text class="m" x="${lx + 20}" y="${ly + 12}">${esc(item.text)}</text>`)
      lx += item.width
    }
  })

  const decisions = nodes.filter((x) => x.kind === 'decision').length
  const outcomes = nodes.filter((x) => x.kind === 'outcome')
  const yesNo = outcomes.every((o) => o.kind === 'outcome' && endOf(o, flow.flow.returnsBoolean).cls !== 'out')
  const description =
    `Vantle's flowchart of ${flow.flow.id}${labeled ? '' : ', showing the raw code'}. It starts at "${question}" ` +
    `and has ${decisions} decision box${decisions === 1 ? '' : 'es'} and ${flow.edges.length} arrow${flow.edges.length === 1 ? '' : 's'} between boxes. ` +
    (items.length ? 'Boxes are coloured by where their data comes from, as the legend shows. ' : '') +
    (yesNo ? 'Every path ends in YES or NO.' : `Every path ends in one of ${outcomes.length} outcome${outcomes.length === 1 ? '' : 's'}.`)

  const P = 20
  const vb = [-P, -head - P, width + 2 * P, (out.height ?? 0) + head + 2 * P]
  const id = `vantle-${flow.flow.slug.replace(/[^A-Za-z0-9_-]/g, '-')}`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(n).join(' ')}" width="${n(vb[2]!)}" height="${n(vb[3]!)}" role="img" aria-labelledby="${id}-title ${id}-desc">`,
    `<title id="${id}-title">${esc(question)}</title>`,
    `<desc id="${id}-desc">${esc(description)}</desc>`,
    STYLE,
    `<rect class="bg" x="${n(vb[0]! + 0.5)}" y="${n(vb[1]! + 0.5)}" width="${n(vb[2]! - 1)}" height="${n(vb[3]! - 1)}" rx="8"/>`,
    ...legend,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}

/** How an outcome's end looks: YES and NO for a function that returns a boolean, its value otherwise. */
function endOf(node: AnyNode & { kind: 'outcome' }, returnsBoolean: boolean): { cls: 'yes' | 'no' | 'out'; code: boolean; lines: string[] } {
  const label = 'label' in node ? node.label : undefined
  if (returnsBoolean && node.value === 'true') return { cls: 'yes', code: false, lines: [label ?? 'YES'] }
  if (returnsBoolean && node.value === 'false') return { cls: 'no', code: false, lines: [label ?? 'NO'] }
  return { cls: 'out', code: label === undefined, lines: clip(wrap(label ?? node.value, 24)) }
}

/** An arrow's label: yes, no, or a case name, cut to MAX_CASE characters. A "next" arrow has none. */
function arrowText(from: AnyNode | undefined, label: string): string {
  if (label === 'next') return ''
  // Counted in characters, not UTF-16 units, so an emoji is never cut in half.
  const chars = [...edgeLabel(from, label)]
  return chars.length <= MAX_CASE ? chars.join('') : `${chars.slice(0, MAX_CASE - 1).join('')}…`
}

function boxClass(node: AnyNode): string {
  if (node.kind === 'opaque' || node.kind === 'action') return node.kind
  if (node.kind === 'decision') return 'category' in node ? node.category : node.categoryHint
  return 'out'
}

/** Breaks text into lines of at most `max` characters, splitting words longer than a line. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = []
  let current = ''
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) {
      if (current) lines.push(current)
      current = ''
      lines.push(word.slice(0, max))
      word = word.slice(max)
    }
    if (!word) continue
    if (current && current.length + 1 + word.length > max) {
      lines.push(current)
      current = word
    } else current = current ? `${current} ${word}` : word
  }
  if (current || !lines.length) lines.push(current)
  return lines
}

function clip(lines: string[]): string[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]} …`]
}

function widest(lines: string[], char: number): number {
  return Math.max(...lines.map((l) => l.length)) * char
}

/** An orthogonal path through ELK's points, with rounded corners. */
function roundedPath(pts: ElkPoint[], r = 6): string {
  let d = `M${n(pts[0]!.x)},${n(pts[0]!.y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const c = pts[i + 1]!
    const d1 = Math.hypot(b.x - a.x, b.y - a.y)
    const d2 = Math.hypot(c.x - b.x, c.y - b.y)
    if (d1 === 0 || d2 === 0) continue
    const rr = Math.min(r, d1 / 2, d2 / 2)
    const p1 = { x: b.x - ((b.x - a.x) / d1) * rr, y: b.y - ((b.y - a.y) / d1) * rr }
    const p2 = { x: b.x + ((c.x - b.x) / d2) * rr, y: b.y + ((c.y - b.y) / d2) * rr }
    d += ` L${n(p1.x)},${n(p1.y)} Q${n(b.x)},${n(b.y)} ${n(p2.x)},${n(p2.y)}`
  }
  const z = pts[pts.length - 1]!
  return `${d} L${n(z.x)},${n(z.y)}`
}

/** Rounds to one decimal place, without a trailing ".0". */
function n(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** Escapes text for XML, and drops control characters, which XML doesn't allow. */
function esc(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const SANS = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

const STYLE = `<style>
  .t{font:500 13px ${SANS};fill:#101010}
  .tc{font:12px ${MONO};fill:#101010}
  .tstart{font:600 13px ${SANS};fill:#FFFFFF}
  .m{font:12px ${SANS};fill:#5f5f5a}
  .lbl{font:500 11px ${MONO};fill:#5f5f5a}
  .lblbg{fill:#FFFFFF}
  .bg{fill:#FFFFFF;stroke:#C9C9C3}
  .box{stroke-width:1.2}
  .pref{fill:#E3ECFB;stroke:#5B86D6} .state{fill:#FBF3D5;stroke:#C29A1F} .input{fill:#FBE6DA;stroke:#D27445}
  .external{fill:#EEEEEA;stroke:#8E8E88} .action{fill:#F6F6F3;stroke:#A8A8A2}
  .opaque{fill:#FFFFFF;stroke:#8E8E88;stroke-dasharray:4 3}
  .start{fill:#101010;stroke:#101010}
  .arr{fill:none;stroke:#8E8E88;stroke-width:1.3} .ah{fill:#8E8E88}
  .yes{fill:#1f7a3a} .no{fill:#FFFFFF;stroke:#b4361f;stroke-width:1.3} .out{fill:#EFE6FB;stroke:#8A5CC7;stroke-width:1.3}
  .tyes,.tno,.tout{font:600 11px ${SANS}} .tyes{fill:#FFFFFF} .tno{fill:#b4361f} .tout{fill:#4B2A7A}
  .tout.tcode{font:500 11px ${MONO}}
  @media (prefers-color-scheme: dark){
    .t,.tc{fill:#ECECE8} .m,.lbl{fill:#8E8E88} .lblbg{fill:#141414} .bg{fill:#141414;stroke:#2C2C2A}
    .pref{fill:#1B2840;stroke:#5B86D6} .state{fill:#332B12;stroke:#C29A1F} .input{fill:#3A2117;stroke:#D27445}
    .external{fill:#262624;stroke:#8E8E88} .action{fill:#1E1E1C;stroke:#6A6A66} .opaque{fill:#141414;stroke:#8E8E88}
    .start{fill:#ECECE8;stroke:#ECECE8} .tstart{fill:#141414}
    .arr{stroke:#6A6A66} .ah{fill:#6A6A66}
    .yes{fill:#4fbf6f} .tyes{fill:#141414} .no{fill:#141414;stroke:#f07a5f} .tno{fill:#f07a5f}
    .out{fill:#2A1F3A;stroke:#A57FE0} .tout{fill:#D9C6F7}
  }
</style>`

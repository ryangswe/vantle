import { describe, expect, it } from 'vitest'
import { toMarkdown, toMermaid } from '../src/render/mermaid.js'
import { extract, FIXTURE } from './helpers.js'

describe('render', () => {
  const flow = extract(FIXTURE)

  it('draws a Mermaid flowchart that starts from the question', () => {
    const mmd = toMermaid(flow)
    expect(mmd.startsWith('flowchart TD\n')).toBe(true)
    expect(mmd).toContain('start(["Should we send a notification?"])')
    expect(mmd).toMatch(/\(\("YES"\)\):::yes/)
    expect(mmd).toMatch(/\(\("NO"\)\):::no/)
  })

  it('escapes characters that would break Mermaid labels', () => {
    const mmd = toMermaid(flow)
    // Every node label is wrapped in quotes, so no raw quote can appear inside one.
    for (const line of mmd.split('\n').filter((l) => /^\s+n\d+\[/.test(l))) {
      const inner = line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]'))
      expect(inner).not.toContain('"')
    }
    expect(mmd).toContain("device === 'mobile'?")
  })

  it('writes a markdown page with the chart, legend and stats', () => {
    const md = toMarkdown(flow)
    expect(md).toContain('# Should we send a notification?')
    expect(md).toContain('```mermaid\nflowchart TD')
    expect(md).toContain('26 decisions, 2 outcomes')
    expect(md).toContain('1,311 paths (first 64 stored)')
  })
})

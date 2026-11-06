// Re-extracts the functions a coverage run charted, so a fix can be measured on the same charts.
// Usage: npx tsx experiments/rerun.ts <repos dir> <old results dir> <out dir>
// For each <old results dir>/<repo>/summary.json, loads the same package and
// extracts the same functions (file, line and name), writing the same files as coverage.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Node } from 'ts-morph'
import { DEFAULT_EXTRACT_OPTIONS, extractFlow } from '../src/extract/extract.js'
import { functionName, loadProject, relPath, type FunctionLike } from '../src/project.js'
import { toMarkdown } from '../src/render/mermaid.js'

const [reposDir, oldDir, outDir] = process.argv.slice(2)
if (!reposDir || !oldDir || !outDir) throw new Error('usage: rerun.ts <repos dir> <old results dir> <out dir>')
const only = process.env.REPOS?.split(',')

type Chart = { rank: number; name: string; file: string; line: number; lines: number; scanBoxes: number; own: number }
for (const repo of readdirSync(oldDir)) {
  if (only && !only.includes(repo)) continue
  const summaryFile = path.join(oldDir, repo, 'summary.json')
  if (!existsSync(summaryFile)) continue
  const old = JSON.parse(readFileSync(summaryFile, 'utf8')) as { package?: string; charts?: Chart[] }
  if (!old.package || !old.charts) continue
  const out = path.join(outDir, repo)
  mkdirSync(out, { recursive: true })
  const vp = loadProject(path.join(reposDir, repo, old.package))
  const charts = old.charts.map((c) => {
    const source = vp.sourceFiles.find((f) => relPath(vp.root, f) === c.file)
    let fn: FunctionLike | undefined
    source?.forEachDescendant((node) => {
      if (fn) return
      if ((Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) && node.getStartLineNumber() === c.line && functionName(node) === c.name) fn = node
    })
    if (!fn || !source) return { ...c, error: 'function not found again', mechanical: false }
    const start = Date.now()
    try {
      const flow = extractFlow(vp, { fn, file: source, name: c.name, question: '' }, `chart-${c.rank}`, DEFAULT_EXTRACT_OPTIONS)
      const ms = Date.now() - start
      const decisions = flow.nodes.filter((n) => n.kind === 'decision')
      const labels = decisions.map((n) => (n.kind === 'decision' ? n.rawLabel : ''))
      const short = decisions.length ? labels.filter((l) => l.length <= 160).length / decisions.length : 1
      writeFileSync(path.join(out, `chart-${c.rank}.md`), toMarkdown(flow, { svg: false }))
      writeFileSync(path.join(out, `chart-${c.rank}.json`), JSON.stringify(flow))
      return {
        ...c,
        ms,
        boxes: decisions.length,
        outcomes: flow.nodes.filter((n) => n.kind === 'outcome').length,
        paths: flow.pathCount,
        shortLabels: short,
        longestLabel: Math.max(0, ...labels.map((l) => l.length)),
        notCharted: flow.notCharted?.length ?? 0,
        warnings: flow.warnings.length,
        scope: flow.scope?.length ?? 1,
        mechanical: ms <= 60_000 && decisions.length >= 2 && decisions.length <= 50 && short >= 0.9,
      }
    } catch (e) {
      return { ...c, ms: Date.now() - start, error: String(e instanceof Error ? e.message : e).slice(0, 500), mechanical: false }
    }
  })
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ...old, charts }, null, 2))
  console.log(JSON.stringify({ repo, charts: charts.map((c) => ({ rank: c.rank, boxes: 'boxes' in c ? c.boxes : undefined, mechanical: c.mechanical, error: 'error' in c ? c.error : undefined })) }))
}

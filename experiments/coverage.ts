// Test A of docs/experiments/no-user-tests.md: extractor coverage on one repo.
// Usage: npx tsx experiments/coverage.ts <repo dir> <out dir>
// Picks the package by the protocol's rule, scans it, extracts the top three
// functions and writes each chart as Markdown plus a summary JSON.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_EXTRACT_OPTIONS, extractFlow } from '../src/extract/extract.js'
import { functionName, loadProject, relPath, type FunctionLike, type VantleProject } from '../src/project.js'
import { toMarkdown } from '../src/render/mermaid.js'
import { scan } from '../src/scan.js'
import { Node } from 'ts-morph'

const [repo, out] = process.argv.slice(2)
if (!repo || !out) throw new Error('usage: coverage.ts <repo dir> <out dir>')
mkdirSync(out, { recursive: true })

const SKIP_DIR = /^(node_modules|dist|build|\.git|\.next|coverage|out)$/
const TEST = /(\.|\/)(test|spec|e2e|stories)\.|__tests__|__mocks__|(^|\/)(tests?|e2e|fixtures|mocks?)\//
const GENERATED = /generated|\.gen\.|codegen/i

/** Every folder with a tsconfig.json, and the .ts/.tsx files whose nearest tsconfig is that one. */
function packages(root: string) {
  const found: { dir: string; ts: number; tsx: number }[] = []
  const walk = (dir: string, owner: { dir: string; ts: number; tsx: number } | undefined) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('tsconfig.json')) {
      owner = { dir, ts: 0, tsx: 0 }
      found.push(owner)
    }
    for (const e of entries) {
      const p = path.join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.test(e)) walk(p, owner)
      } else if (owner && !e.endsWith('.d.ts')) {
        const rel = path.relative(root, p)
        if (TEST.test(rel) || GENERATED.test(rel)) continue
        if (e.endsWith('.tsx')) owner.tsx++
        else if (e.endsWith('.ts')) owner.ts++
      }
    }
  }
  walk(root, undefined)
  return found.filter((p) => p.ts > p.tsx).sort((a, b) => b.ts - a.ts)
}

function findFunction(vp: VantleProject, file: string, line: number, name: string): FunctionLike | undefined {
  const source = vp.sourceFiles.find((f) => relPath(vp.root, f) === file)
  let hit: FunctionLike | undefined
  source?.forEachDescendant((node) => {
    if (hit) return
    if ((Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) && node.getStartLineNumber() === line && functionName(node) === name) hit = node
  })
  return hit
}

const candidates = packages(repo)
const tried: { dir: string; error: string }[] = []
let vp: VantleProject | undefined
for (const c of candidates) {
  try {
    const loaded = loadProject(c.dir)
    if (loaded.sourceFiles.length === 0) throw new Error('tsconfig loads no source files')
    vp = loaded
    break
  } catch (e) {
    tried.push({ dir: path.relative(repo, c.dir), error: String(e instanceof Error ? e.message : e).slice(0, 300) })
  }
}
if (!vp) {
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ repo, error: 'no package loads', tried }, null, 2))
  process.exit(0)
}

const scanStart = Date.now()
const rows = scan(vp).filter((r) => !TEST.test(r.file) && !GENERATED.test(r.file))
const scanMs = Date.now() - scanStart
const top = rows.slice(0, 3)
const charts = top.map((row, i) => {
  const fn = findFunction(vp!, row.file, row.line, row.name)
  const base = { rank: i + 1, name: row.name, file: row.file, line: row.line, lines: row.lines, scanBoxes: row.boxes, own: row.own }
  if (!fn) return { ...base, error: 'function not found again' }
  const sourceFile = vp!.sourceFiles.find((f) => relPath(vp!.root, f) === row.file)!
  const start = Date.now()
  try {
    const flow = extractFlow(vp!, { fn, file: sourceFile, name: row.name, question: '' }, `chart-${i + 1}`, DEFAULT_EXTRACT_OPTIONS)
    const ms = Date.now() - start
    const decisions = flow.nodes.filter((n) => n.kind === 'decision')
    const labels = decisions.map((n) => (n.kind === 'decision' ? n.rawLabel : ''))
    const short = labels.filter((l) => l.length <= 160).length
    writeFileSync(path.join(out, `chart-${i + 1}.md`), toMarkdown(flow, { svg: false }))
    writeFileSync(path.join(out, `chart-${i + 1}.json`), JSON.stringify(flow))
    return {
      ...base,
      ms,
      boxes: decisions.length,
      outcomes: flow.nodes.filter((n) => n.kind === 'outcome').length,
      paths: flow.pathCount,
      shortLabels: decisions.length ? short / decisions.length : 1,
      longestLabel: Math.max(0, ...labels.map((l) => l.length)),
      notCharted: flow.notCharted?.length ?? 0,
      warnings: flow.warnings.length,
      scope: flow.scope?.length ?? 1,
      mechanical: ms <= 60_000 && decisions.length >= 2 && decisions.length <= 50 && (decisions.length ? short / decisions.length : 1) >= 0.9,
    }
  } catch (e) {
    return { ...base, ms: Date.now() - start, error: String(e instanceof Error ? e.message : e).slice(0, 500), mechanical: false }
  }
})

const summary = {
  repo: path.basename(repo),
  package: path.relative(repo, vp.root) || '.',
  tried,
  files: vp.sourceFiles.length,
  scanned: rows.length,
  scanErrors: rows.filter((r) => r.error).length,
  scanErrorSamples: rows.filter((r) => r.error).slice(0, 5).map((r) => `${r.file}#${r.name}: ${r.error!.slice(0, 200)}`),
  scanMs,
  charts,
}
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ repo: summary.repo, package: summary.package, files: summary.files, scanned: summary.scanned, scanErrors: summary.scanErrors, scanMs, charts: charts.map((c) => ({ name: c.name, boxes: 'boxes' in c ? c.boxes : undefined, ms: c.ms, mechanical: c.mechanical, error: 'error' in c ? c.error : undefined })) }))

#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Command, InvalidArgumentError, Option } from 'commander'
import { DEFAULT_EXTRACT_OPTIONS, extractFlow } from './extract/extract.js'
import { expectedToGraph, loadExpected } from './graph/expected.js'
import { compareBehavior, toGraph } from './graph/paths.js'
import { judgeLabels } from './label/judge.js'
import { labelFlow, LabelingFailed, labelRequest } from './label/label.js'
import { anthropicModel, AuthFailed, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_TEST_EFFORT, MissingCredentials, ModelRefusal, type Effort } from './label/model.js'
import { labelOutputFromFlow, shortIds, validateLabels } from './label/validate.js'
import { findAnnotations, flowSlug, loadProject, relPath, UsageError, type Annotation, type VantleProject } from './project.js'
import { completenessSummary, toMarkdown, toMermaid } from './render/mermaid.js'
import { toSvg } from './render/svg.js'
import { scan } from './scan.js'
import { RawFlow } from './schema/flow.js'
import { isLabeled, LabeledFlow, type AnyFlow } from './schema/labeled.js'
import { verifyFlow } from './verify/verify.js'
import { claudeTestWriter } from './verify/writer.js'

const EXIT = { ok: 0, usage: 1, validation: 2, verification: 3 } as const
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const program = new Command()
  .name('vantle')
  .description('Turn decision logic in code into flowcharts checked against the real code.')
  .option('-p, --project <dir>', 'project root (the folder with tsconfig.json)', '.')
  .showHelpAfterError()

const modelOption = () => new Option('--model <id>', 'Claude model for labeling').default(DEFAULT_MODEL)
const effortOption = () => new Option('--effort <level>', 'how hard the model thinks').choices(EFFORTS).default(DEFAULT_EFFORT)

program
  .command('scan')
  .description('rank functions by how much decision logic they reach, to find what to mark with @vantle')
  .argument('[path]', 'only list functions in files under this path')
  .option('-n, --top <n>', 'how many to list', toInt, 10)
  .option('--json', 'print JSON')
  .action((under: string | undefined, opts: { top: number; json?: boolean }) => {
    const vp = project()
    const rows = scan(vp, under).slice(0, opts.top)
    if (opts.json) return print(JSON.stringify(rows, null, 2))
    if (!rows.length) return print('No functions with decision logic found.')
    const table = [
      ['#', 'function', 'where', 'chart boxes', 'own decisions', 'lines', ''],
      ...rows.map((r, i) => [String(i + 1), r.name, `${r.file}:${r.line}`, String(r.boxes), String(r.own), String(r.lines), r.marked ? '@vantle' : '']),
    ]
    print(formatTable(table))
    const failed = rows.filter((r) => r.error)
    if (failed.length) print(`\n! Vantle couldn't chart ${failed.length} of these (shown with 0 chart boxes). First: ${failed[0]!.name}: ${failed[0]!.error}`)
    print('\n"chart boxes" is how many boxes its chart would have, following calls into helpers. Mark a top entry with // @vantle: "<question>".')
  })

program
  .command('extract')
  .description('build the raw decision graph for marked functions (no LLM)')
  .argument('[flow]', 'flow slug or function name; all marked functions if omitted')
  .option('--depth <n>', 'levels of calls to follow', toInt, DEFAULT_EXTRACT_OPTIONS.depth)
  .option('--max-paths <n>', 'paths to store per flow', toInt, DEFAULT_EXTRACT_OPTIONS.maxPaths)
  .option('--max-inline <n>', 'helpers that would add more boxes than this stay as one box', toInt, DEFAULT_EXTRACT_OPTIONS.maxInline)
  .option('--max-boxes <n>', 'a chart bigger than this follows helpers less deep, when that brings it under', toInt, DEFAULT_EXTRACT_OPTIONS.maxBoxes)
  .option('--json', 'print the graph JSON instead of a summary')
  .action((flow: string | undefined, opts: ExtractCliOptions) => {
    const vp = project()
    for (const result of extractSelected(vp, flow, opts)) {
      if (opts.json) print(JSON.stringify(result.flow, null, 2))
      else summarize(vp, result.flow, [result.rawPath])
    }
  })

program
  .command('label')
  .description('write product-language labels for extracted flows with Claude, then validate them')
  .argument('[flow]', 'flow slug; all extracted flows if omitted')
  .addOption(modelOption())
  .addOption(effortOption())
  .option('--dry-run', 'print what would be sent to the model and a rough cost, without sending it')
  .action(async (flow: string | undefined, opts: LabelCliOptions) => {
    const vp = project()
    for (const slug of selectExtracted(vp, flow)) {
      const raw = readRaw(vp, slug)
      if (opts.dryRun) {
        dryRun(vp, raw, opts)
        continue
      }
      const labeled = await runLabeling(vp, raw, opts)
      print(`✔ ${slug}  labeled by ${labeled.labeling.model}  ${labelingSummary(labeled)}`)
      print(`  → ${rel(vp, labeledPath(vp, slug))}`)
    }
  })

program
  .command('validate')
  .description('re-check saved labels against the current extracted flow')
  .argument('[flow]', 'flow slug; all labeled flows if omitted')
  .action((flow: string | undefined) => {
    const vp = project()
    const slugs = flow ? [flow] : selectExtracted(vp, undefined).filter((s) => existsSync(labeledPath(vp, s)))
    if (!slugs.length) throw new UsageError('No labeled flows yet. Run `vantle label` first.')
    for (const slug of slugs) {
      const raw = readRaw(vp, slug)
      const labeled = readLabeled(vp, slug)
      if (!labeled) throw new UsageError(`"${slug}" has no labels yet. Run \`vantle label ${slug}\`.`)
      const problems: string[] = []
      if (labeled.flow.sourceHash !== raw.flow.sourceHash) problems.push('The code changed since these labels were written.')
      const ids = shortIds(raw)
      const result = validateLabels(raw, labelOutputFromFlow(labeled, ids), ids)
      if (!result.ok) problems.push(...result.errors)
      if (problems.length) {
        print(`✖ ${slug}`)
        for (const p of problems) print(`  - ${p}`)
        print(`  Run \`vantle label ${slug}\` to relabel.`)
        process.exitCode = EXIT.validation
      } else {
        print(`✔ ${slug}  labels match the extracted chart`)
      }
    }
  })

program
  .command('render')
  .description('write SVG (.svg), Mermaid (.mmd) and markdown (.md) charts, using labels when they are up to date')
  .argument('[flow]', 'flow slug; all extracted flows if omitted')
  .action(async (flow: string | undefined) => {
    const vp = project()
    for (const slug of selectExtracted(vp, flow)) {
      const { flow: chosen, note } = bestFlow(vp, slug)
      const written = await render(vp, chosen)
      print(`✔ ${slug}  → ${written.map((w) => rel(vp, w)).join(', ')}`)
      if (note) print(`  ! ${note}`)
    }
  })

program
  .command('generate')
  .description('extract, label, validate and render marked functions')
  .argument('[flow]', 'flow slug or function name; all marked functions if omitted')
  .option('--depth <n>', 'levels of calls to follow', toInt, DEFAULT_EXTRACT_OPTIONS.depth)
  .option('--max-paths <n>', 'paths to store per flow', toInt, DEFAULT_EXTRACT_OPTIONS.maxPaths)
  .option('--max-inline <n>', 'helpers that would add more boxes than this stay as one box', toInt, DEFAULT_EXTRACT_OPTIONS.maxInline)
  .option('--max-boxes <n>', 'a chart bigger than this follows helpers less deep, when that brings it under', toInt, DEFAULT_EXTRACT_OPTIONS.maxBoxes)
  .option('--no-label', 'skip labeling and render raw code')
  .addOption(modelOption())
  .addOption(effortOption())
  .action(async (flow: string | undefined, opts: ExtractCliOptions & LabelCliOptions & { label: boolean }) => {
    const vp = project()
    for (const result of extractSelected(vp, flow, opts)) {
      let chart: AnyFlow = result.flow
      const files = [result.rawPath]
      let note: string | undefined
      if (opts.label) {
        try {
          chart = await runLabeling(vp, result.flow, opts)
          files.push(labeledPath(vp, result.flow.flow.slug))
        } catch (error) {
          if (!(error instanceof MissingCredentials)) throw error
          note = 'Skipped labels: no Anthropic credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`), or pass --no-label.'
        }
      }
      files.push(...(await render(vp, chart)))
      summarize(vp, result.flow, files)
      if (chart !== result.flow) print(`  labeled by ${(chart as LabeledFlow).labeling.model}  ${labelingSummary(chart as LabeledFlow)}`)
      if (note) print(`  ! ${note}`)
    }
  })

program
  .command('verify')
  .description('check the chart against the real code: run a test for paths covering every arrow and record a status per path')
  .argument('[flow]', 'flow slug; all extracted flows if omitted')
  .option('--regenerate', 'write new tests even where saved ones exist')
  .option('--all-paths', 'test every path (up to 200) instead of a set that covers every arrow')
  .addOption(modelOption())
  // Writing tests at low effort cost about 30% less than medium, with the same results.
  .addOption(effortOption().default(DEFAULT_TEST_EFFORT))
  .action(async (flow: string | undefined, opts: { regenerate?: boolean; allPaths?: boolean; model: string; effort: Effort }) => {
    const vp = project()
    for (const slug of selectExtracted(vp, flow)) {
      const { flow: chart } = bestFlow(vp, slug)
      const codeChanged = currentSourceHash(vp, chart) !== chart.flow.sourceHash
      const options = { regenerate: opts.regenerate, allPaths: opts.allPaths, codeChanged }
      let note: string | undefined
      let verified: AnyFlow
      try {
        verified = await verifyFlow(vp, chart, claudeTestWriter(anthropicModel(), { model: opts.model, effort: opts.effort }), options)
      } catch (error) {
        if (!(error instanceof MissingCredentials)) throw error
        note = 'No Anthropic credentials, so only saved tests ran. Set ANTHROPIC_API_KEY or run `ant auth login` to write new ones.'
        verified = await verifyFlow(vp, chart, undefined, options)
      }
      const file = isLabeled(verified) ? labeledPath(vp, slug) : path.join(flowsDir(vp), `${slug}.raw.json`)
      writeFileSync(file, JSON.stringify(verified, null, 2) + '\n')
      await render(vp, verified)

      const v = verified.verification!
      const c = v.counts
      const saved = verified.paths.filter((p) => p.test).length - v.generatedTests
      const cost = v.generatedTests
        ? ` · wrote ${v.generatedTests} test${v.generatedTests === 1 ? '' : 's'}${v.costUsd === null ? '' : ` (~$${v.costUsd.toFixed(3)})`}`
        : saved > 0
          ? ' · reused saved tests'
          : ''
      const gaps = v.completeness?.gaps ?? []
      const missing = gaps.filter((g) => g.status === 'missing').length
      const mark = c.failed || missing || v.outOfDate ? '✖' : '✔'
      print(`${mark} ${slug}  ${c.verified} verified · ${c.failed} failed · ${c.untestable} couldn't build a test · ${c.unverified} unverified · ${v.arrowsVerified}/${v.arrowsTotal} arrows verified${cost} · ${(v.durationMs / 1000).toFixed(1)} s`)
      if (v.spend) {
        const parts = (['paths', 'repairs', 'gaps'] as const).flatMap((phase) => {
          const p = v.spend![phase]
          if (!p.requests) return []
          const cost = p.costUsd === null ? '' : ` $${p.costUsd.toFixed(3)}`
          return [`${phase} ${p.tests} test${p.tests === 1 ? '' : 's'} in ${p.requests} request${p.requests === 1 ? '' : 's'}${cost} (${tokens(p.inputTokens)} in, ${tokens(p.cachedTokens)} cached, ${tokens(p.outputTokens)} out)`]
        })
        if (parts.length) print(`  spend: ${parts.join(' · ')}`)
      }
      if (v.outOfDate) print("  ! Some boxes' code can't be found any more, so the chart is out of date. Run `vantle generate`, then verify.")
      else if (codeChanged) print('  ! The code changed since this chart was extracted. Failures may mean the chart is out of date; run `vantle generate`.')
      for (const p of verified.paths) {
        if (p.status === 'verified') continue
        print(`  ${p.status.padEnd(10)} ${p.id}  ${(p.note ?? '').split('\n')[0]}`)
      }
      if (v.completeness) {
        print(`  code: ${completenessSummary(v.completeness)}`)
        for (const g of gaps) print(`  ${g.status.padEnd(10)} ${g.id}  ${g.file}:${g.line} \`${g.code}\`  ${(g.note ?? '').split('\n')[0]}`)
      }
      if (note) print(`  ! ${note}`)
      print(`  → ${rel(vp, file)}`)
      if (c.failed || missing || v.outOfDate) process.exitCode = EXIT.verification
    }
  })

program
  .command('score')
  .description('compare a flow to a hand-written expected.json: behavior always, labels with --labels')
  .argument('<expected>', 'path to expected.json')
  .argument('[flow]', 'flow slug; inferred from expected.json if omitted')
  .option('--labels', "also grade the flow's labels against the reference labels with an LLM judge")
  .addOption(modelOption())
  .addOption(new Option('--effort <level>', 'judge effort').choices(EFFORTS).default('low'))
  .option('--json', 'print results as JSON')
  .action(async (expectedPath: string, flow: string | undefined, opts: { labels?: boolean; model: string; effort: Effort; json?: boolean }) => {
    const vp = project()
    const expected = loadExpected(path.resolve(expectedPath))
    const slug = flow ?? flowSlug(expected.flow.split('#')[1] ?? '')
    const actual = readRaw(vp, slug)
    const behavior = compareBehavior(expectedToGraph(expected), toGraph(actual.root, actual.nodes, actual.edges))

    let labels: Awaited<ReturnType<typeof judgeLabels>> | undefined
    if (opts.labels) {
      const labeled = readLabeled(vp, slug)
      if (!labeled) throw new UsageError(`"${slug}" has no labels to grade. Run \`vantle label ${slug}\` first.`)
      labels = await judgeLabels(expected, labeled, anthropicModel(), { model: opts.model, effort: opts.effort })
    }
    if (!behavior.equivalent) process.exitCode = EXIT.validation
    if (opts.json) return print(JSON.stringify({ slug, behavior, labels }, null, 2))

    if (behavior.equivalent) {
      print(`✔ ${slug} behaves the same as ${expectedPath} for every input (${behavior.actualPaths.toLocaleString('en-US')} paths checked).`)
    } else {
      print(`✖ ${slug} differs from ${expectedPath}.`)
      for (const c of behavior.counterexamples) {
        print(`\n  expected ${c.expected}, got ${c.actual} when:`)
        for (const [k, v] of Object.entries(c.inputs)) print(`    ${k} = ${v}`)
      }
      if (behavior.onlyInExpected.length) print(`\n  Only in expected:\n${behavior.onlyInExpected.map((v) => `    ${v}`).join('\n')}`)
      if (behavior.onlyInActual.length) print(`\n  Only in extracted:\n${behavior.onlyInActual.map((v) => `    ${v}`).join('\n')}`)
    }
    if (labels) {
      print(`\nLabel score: ${labels.average.toFixed(2)} / 5 across ${labels.verdicts.length} boxes`)
      const table = [['score', 'reference', 'generated', 'note'], ...labels.verdicts.map((v) => [String(v.score), v.expected, v.generated, v.score < 5 ? v.note : ''])]
      print(formatTable(table))
      if (labels.unpaired.length) print(`  ! Couldn't pair: ${labels.unpaired.join(', ')}`)
    }
  })

// ---------------------------------------------------------------------------

interface ExtractCliOptions {
  depth: number
  maxPaths: number
  maxInline: number
  maxBoxes: number
  json?: boolean
}

interface LabelCliOptions {
  model: string
  effort: Effort
  dryRun?: boolean
}

function project(): VantleProject {
  return loadProject(program.opts<{ project: string }>().project)
}

function extractSelected(vp: VantleProject, selector: string | undefined, opts: ExtractCliOptions) {
  const annotations = findAnnotations(vp)
  if (!annotations.length) {
    throw new UsageError('No functions are marked yet. Add // @vantle: "<question>" above one. `vantle scan` suggests where.')
  }
  const slugs = assignSlugs(vp, annotations)
  const chosen = selector ? annotations.filter((a) => slugs.get(a) === selector || a.name === selector) : annotations
  if (!chosen.length) {
    throw new UsageError(`No marked function matches "${selector}". Marked: ${[...slugs.values()].join(', ')}`)
  }
  const dir = flowsDir(vp)
  mkdirSync(dir, { recursive: true })
  return chosen.map((a) => {
    const flow = extractFlow(vp, a, slugs.get(a)!, { depth: opts.depth, maxPaths: opts.maxPaths, maxInline: opts.maxInline, maxBoxes: opts.maxBoxes })
    const rawPath = path.join(dir, `${flow.flow.slug}.raw.json`)
    writeFileSync(rawPath, JSON.stringify(flow, null, 2) + '\n')
    return { flow, rawPath }
  })
}

async function runLabeling(vp: VantleProject, raw: RawFlow, opts: LabelCliOptions): Promise<LabeledFlow> {
  try {
    const labeled = await labelFlow(vp, raw, anthropicModel(), { model: opts.model, effort: opts.effort })
    writeFileSync(labeledPath(vp, raw.flow.slug), JSON.stringify(labeled, null, 2) + '\n')
    return labeled
  } catch (error) {
    if (error instanceof LabelingFailed) {
      throw new LabelingError(`${error.message}\n${error.errors.map((e) => `  - ${e}`).join('\n')}`)
    }
    if (error instanceof ModelRefusal) throw new LabelingError(error.message)
    throw error
  }
}

function dryRun(vp: VantleProject, raw: RawFlow, opts: LabelCliOptions) {
  const { system, prompt } = labelRequest(vp, raw)
  // Roughly 4 characters per token for code-heavy English. Output covers labels plus thinking.
  const inputTokens = Math.ceil((system.length + prompt.length) / 4)
  const decisions = raw.nodes.filter((n) => n.kind === 'decision').length
  const outputTokens = 1500 + decisions * 150
  print(`# ${raw.flow.slug}: request for ${opts.model} (effort ${opts.effort})\n`)
  print('## System\n')
  print(system)
  print('\n## Prompt\n')
  print(prompt)
  print(`\n# Rough size: ~${inputTokens.toLocaleString('en-US')} input tokens, ~${outputTokens.toLocaleString('en-US')} output tokens (estimate).`)
  print('# Only the code shown above leaves your machine, and it goes only to Anthropic.')
}

function labelingSummary(flow: LabeledFlow): string {
  const l = flow.labeling
  const cost = l.costUsd === null ? '' : ` · ~$${l.costUsd.toFixed(3)}`
  return `(${l.attempts} attempt${l.attempts === 1 ? '' : 's'} · ${l.inputTokens.toLocaleString('en-US')} in / ${l.outputTokens.toLocaleString('en-US')} out tokens${cost} · ${(l.durationMs / 1000).toFixed(1)} s)`
}

/** The labeled flow when its labels match the current code, otherwise the raw one. */
function bestFlow(vp: VantleProject, slug: string): { flow: AnyFlow; note?: string } {
  const raw = readRaw(vp, slug)
  const labeled = readLabeled(vp, slug)
  if (!labeled) return { flow: raw }
  if (labeled.flow.sourceHash !== raw.flow.sourceHash) {
    return { flow: raw, note: `Labels are out of date with the code. Run \`vantle label ${slug}\`.` }
  }
  return { flow: labeled }
}

/** Source hash the chart would have if it were extracted from the code as it is now. */
function currentSourceHash(vp: VantleProject, flow: AnyFlow): string | undefined {
  const annotation = findAnnotations(vp).find((a) => `${relPath(vp.root, a.file)}#${a.name}` === flow.flow.id)
  if (!annotation) return undefined
  // Which files are read depends on how deep helpers were followed, so extract the way the chart was.
  const saved = flow.flow.extractOptions
  const options = { ...DEFAULT_EXTRACT_OPTIONS, ...(saved ? { maxInline: undefined, maxBoxes: undefined, ...saved } : {}), skipPaths: true }
  return extractFlow(vp, annotation, flow.flow.slug, options).flow.sourceHash
}

/** Slugs come from the function name, with the file added when two functions share a name. */
function assignSlugs(vp: VantleProject, annotations: Annotation[]): Map<Annotation, string> {
  const counts = new Map<string, number>()
  for (const a of annotations) counts.set(flowSlug(a.name), (counts.get(flowSlug(a.name)) ?? 0) + 1)
  return new Map(
    annotations.map((a) => {
      const base = flowSlug(a.name)
      if (counts.get(base) === 1) return [a, base]
      const file = path.relative(vp.root, a.file.getFilePath()).replace(/\.[cm]?tsx?$/, '')
      return [a, `${flowSlug(file)}-${base}`]
    }),
  )
}

async function render(vp: VantleProject, flow: AnyFlow): Promise<string[]> {
  const dir = flowsDir(vp)
  mkdirSync(dir, { recursive: true })
  const svg = path.join(dir, `${flow.flow.slug}.svg`)
  const mmd = path.join(dir, `${flow.flow.slug}.mmd`)
  const md = path.join(dir, `${flow.flow.slug}.md`)
  let drawing: string
  try {
    drawing = await toSvg(flow)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new UsageError(`Couldn't draw the chart for "${flow.flow.slug}": ${reason} Run \`vantle extract ${flow.flow.slug}\` again to rebuild it.`)
  }
  writeFileSync(svg, drawing)
  writeFileSync(mmd, toMermaid(flow))
  writeFileSync(md, toMarkdown(flow))
  return [svg, mmd, md]
}

function summarize(vp: VantleProject, flow: RawFlow, files: string[]) {
  const decisions = flow.nodes.filter((n) => n.kind === 'decision').length
  const outcomes = flow.nodes.filter((n) => n.kind === 'outcome').length
  print(`✔ ${flow.flow.slug}  ${decisions} decisions · ${outcomes} outcomes · ${flow.pathCount.toLocaleString('en-US')} paths  (${flow.run.durationMs} ms)`)
  for (const f of files) print(`  → ${rel(vp, f)}`)
  for (const w of flow.warnings) print(`  ! ${w}`)
  const notCharted = flow.notCharted ?? []
  if (notCharted.length) {
    print(`  not charted: ${notCharted.length} place${notCharted.length === 1 ? '' : 's'} affect the result but aren't drawn (listed in the .md)`)
    for (const n of notCharted.slice(0, 5)) print(`    ${n.kind.padEnd(8)} ${n.file}:${n.line} \`${n.code}\``)
    if (notCharted.length > 5) print(`    … and ${notCharted.length - 5} more`)
  }
}

function flowsDir(vp: VantleProject): string {
  return path.join(vp.root, '.vantle', 'flows')
}

function labeledPath(vp: VantleProject, slug: string): string {
  return path.join(flowsDir(vp), `${slug}.json`)
}

function selectExtracted(vp: VantleProject, flow: string | undefined): string[] {
  const dir = flowsDir(vp)
  const slugs = flow ? [flow] : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.raw.json')).map((f) => f.slice(0, -'.raw.json'.length)) : []
  if (!slugs.length) throw new UsageError('No extracted flows yet. Run `vantle extract` first.')
  return slugs
}

function readRaw(vp: VantleProject, slug: string): RawFlow {
  const file = path.join(flowsDir(vp), `${slug}.raw.json`)
  if (!existsSync(file)) throw new UsageError(`No extracted flow "${slug}". Run \`vantle extract\` first.`)
  return RawFlow.parse(JSON.parse(readFileSync(file, 'utf8')))
}

function readLabeled(vp: VantleProject, slug: string): LabeledFlow | undefined {
  const file = labeledPath(vp, slug)
  if (!existsSync(file)) return undefined
  return LabeledFlow.parse(JSON.parse(readFileSync(file, 'utf8')))
}

function rel(vp: VantleProject, file: string): string {
  return path.relative(process.cwd(), file) || path.relative(vp.root, file)
}

function toInt(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) throw new InvalidArgumentError('Expected a positive whole number.')
  return n
}

function formatTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}

function print(text: string) {
  process.stdout.write(text + '\n')
}

class LabelingError extends Error {}

// Stop quietly when output is piped into something that closes early, like `head`.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

program.parseAsync().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`vantle: ${error.message}\n`)
    process.exitCode = EXIT.usage
    return
  }
  if (error instanceof MissingCredentials) {
    process.stderr.write(`vantle: no Anthropic credentials found. Set ANTHROPIC_API_KEY or run \`ant auth login\`.\n  (${error.message})\n`)
    process.exitCode = EXIT.usage
    return
  }
  if (error instanceof AuthFailed) {
    process.stderr.write(`vantle: Anthropic rejected the credentials.\n  ${error.message}\n`)
    process.exitCode = EXIT.usage
    return
  }
  if (error instanceof LabelingError) {
    process.stderr.write(`vantle: ${error.message}\n`)
    process.exitCode = EXIT.validation
    return
  }
  throw error
})

/** 12,345 tokens as "12.3k". */
function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { shortHash } from '../util.js'
import { enumeratePaths, type GraphPath } from '../graph/paths.js'
import { shortIds } from '../label/validate.js'
import { relPath, type VantleProject } from '../project.js'
import type { Completeness, FlowPath, Gap, PhaseSpend, PathStatus, Spend, Verification } from '../schema/flow.js'
import type { AnyFlow } from '../schema/labeled.js'
import { testContext } from './context.js'
import { coverageTargets, functionEntries, type Target } from './coverage.js'
import { prepareTestRoot, readTrace, runTests, writeProbes, type TestOutcome } from './run.js'
import { addEntryProbes, addReachProbes, chartedReach, checkReach, checkRoute, entered, entryKey, probeTable, routeTaken, type ProbeTable, type Trace } from './route.js'
import { arrowKey, arrows, flowGraph, hasConflict, pathSignature, selectPaths, type Conflict } from './select.js'
import type { PathSpec, TargetSpec, TestAnswer, TestExample, TestRequest, TestWriter } from './writer.js'

export interface VerifyOptions {
  /** Write new tests even when saved ones exist. */
  regenerate?: boolean
  allPaths?: boolean
  /** Paths per request to the test writer. */
  batchSize?: number
  /** Requests to the test writer at once. */
  concurrency?: number
  /** Set when the code changed after the chart was extracted. */
  codeChanged?: boolean
  /** Most new tests to write for code no path test ran. */
  maxReachTests?: number
}

const Manifest = z.object({
  version: z.literal(0),
  flow: z.string(),
  entries: z.record(
    z.string(),
    z.object({
      id: z.string(),
      kind: z.enum(['test', 'impossible']),
      file: z.string().optional(),
      reason: z.string().optional(),
      conflict: z.array(z.object({ node: z.string(), edge: z.string() })).optional(),
      /** For "couldn't build a test": hash of the charted code when the writer said so. */
      code: z.string().optional(),
      /** Set once the test has followed its path, so a later miss means the code changed. */
      followed: z.boolean().optional(),
      writtenAt: z.string(),
    }),
  ),
})
type Manifest = z.infer<typeof Manifest>

interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  generated: number
  spend: Spend
}

function newUsage(): Usage {
  const phase = (): PhaseSpend => ({ requests: 0, tests: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 })
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, generated: 0, spend: { paths: phase(), repairs: phase(), gaps: phase() } }
}

interface Result {
  path: GraphPath
  signature: string
  id: string
  status: PathStatus
  file?: string
  note?: string
}

/**
 * Checks the chart against the real code: picks paths that cover every arrow,
 * gets a test for each (reusing saved ones), runs them, and records a status
 * per path. Without a writer, only saved tests run.
 */
export async function verifyFlow(vp: VantleProject, flow: AnyFlow, writer: TestWriter | undefined, options: VerifyOptions = {}) {
  const started = Date.now()
  const context = testContext(vp, flow)
  const testsRoot = path.dirname(context.testDir)
  prepareTestRoot(testsRoot)
  // Instrumentation: every box records its answer, so tests are checked by the route they take.
  const table = probeTable(flow, (file) => {
    const abs = path.join(vp.root, file)
    // The extractor's offsets don't count a byte-order mark, so neither do these.
    return existsSync(abs) ? readFileSync(abs, 'utf8').replace(/^\uFEFF/, '') : undefined
  })
  // Completeness: every return, throw and branch that matters records that it ran.
  const targets = coverageTargets(vp, flow)
  addReachProbes(table, targets)
  // Each charted function records that the code entered it, to tell a test that never ran it from a missing branch.
  addEntryProbes(table, functionEntries(vp, flow))
  mkdirSync(context.testDir, { recursive: true })
  writeProbes(context.testDir, vp.root, table)

  const manifestPath = path.join(context.testDir, 'manifest.json')
  const manifest = loadManifest(manifestPath, flow.flow.id)
  // The writer's word that no test can be built only holds for the code it read.
  const codeHash = chartedCodeHash(vp, flow)
  for (const [key, e] of Object.entries(manifest.entries)) if (e.kind === 'impossible' && e.code !== codeHash) delete manifest.entries[key]
  // A claim about a path the chart no longer has (it was regenerated) says nothing about this chart.
  const currentPaths = new Set(enumeratePaths(flowGraph(flow), 100_000).paths.map((p) => pathSignature(p)))
  for (const [key, e] of Object.entries(manifest.entries)) if (e.kind === 'impossible' && !key.startsWith('reach:') && !currentPaths.has(key)) delete manifest.entries[key]
  const ids = shortIds(flow)
  const usage = newUsage()

  const conflicts = (): Conflict[] =>
    Object.values(manifest.entries).flatMap((e) => (e.kind === 'impossible' && e.conflict?.length ? [{ arrows: e.conflict, reason: e.reason ?? '' }] : []))

  const results = new Map<string, Result>()
  // Paths keep their ID across runs; new ones continue the numbering.
  const counter = (prefix: string) => {
    let next = 1 + Math.max(0, ...Object.values(manifest.entries).map((e) => (e.id.startsWith(prefix) ? Number(e.id.slice(1)) || 0 : 0)))
    return () => `${prefix}${String(next++).padStart(2, '0')}`
  }
  const newId = counter('p')
  /** Every trace recorded this run, by test file. */
  const traces = new Map<string, Trace>()

  /**
   * A test that ran and followed its path, shown to the writer as a working
   * example. Most broken first drafts fail the same way (a missing mock, a
   * context field the code reads), so one working test saves many repairs.
   */
  const example: { code?: string; followed?: boolean } = {}
  const shown = (): TestExample | undefined => (example.code ? { code: example.code, followed: !!example.followed } : undefined)
  const pickExample = () => {
    // Best: the shortest test that followed its path. Next best: one that ran the
    // function without errors, which still shows a setup that works.
    for (const followed of [true, false]) {
      if (example.code && (example.followed || !followed)) return
      let best: string | undefined
      for (const r of results.values()) {
        if (!r.file || r.status === 'untestable') continue
        const file = path.join(context.testDir, r.file)
        const trace = traces.get(file)
        const ok = followed ? r.status === 'verified' : !!trace?.result && !trace.result.threw && (trace.calls ?? 1) === 1
        if (!ok) continue
        const code = readFileSync(file, 'utf8')
        if (!best || code.length < best.length) best = code
      }
      if (best) {
        Object.assign(example, { code: best, followed })
        return
      }
    }
  }

  /** Runs these rows' tests, and gives new ones that broke one repair. */
  const runAndRepair = async (rows: Result[], fresh: Set<string>) => {
    if (!rows.length) return
    let outcomes = await runTests(testsRoot, rows.map((r) => path.join(context.testDir, r.file!)), flow.flow.slug)
    apply(rows, outcomes, fresh)
    pickExample()
    const broken = rows.filter((r) => r.status === 'unverified' && fresh.has(r.signature))
    if (!writer || !broken.length) return
    const repairs = broken.map((r) => ({
      signature: r.signature,
      id: r.id,
      spec: spec(flow, ids, r.path, r.id, r.signature),
      repair: { id: r.id, code: readFileSync(path.join(context.testDir, r.file!), 'utf8'), error: r.note ?? '' },
    }))
    const answers = await writeTests(writer, flow, context, ids, repairs, options, usage, 'repairs', shown())
    for (const r of repairs) record(r, answers.get(r.id))
    const retried = broken.filter((r) => r.file && results.get(r.signature)?.status !== 'untestable')
    outcomes = await runTests(testsRoot, retried.map((r) => path.join(context.testDir, r.file!)), flow.flow.slug)
    apply(retried, outcomes, fresh)
    pickExample()
  }

  /** Writes tests for these paths, runs them, and repairs the ones that broke. */
  const writeAndRun = async (todo: { path: GraphPath; signature: string; id: string }[]) => {
    const fresh = new Set<string>()
    const answers = await writeTests(writer!, flow, context, ids, todo.map((t) => ({ id: t.id, spec: spec(flow, ids, t.path, t.id, t.signature) })), options, usage, 'paths', shown())
    for (const t of todo) {
      const answer = answers.get(t.id)
      record(t, answer)
      if (answer?.kind === 'test') fresh.add(t.signature)
    }
    const rows = todo.map((t) => results.get(t.signature)!).filter((r) => r.file && r.status !== 'untestable')
    await runAndRepair(rows, fresh)
  }

  /** Gets tests for these paths (saved or new), runs them, and repairs new ones that broke. */
  const handle = async (paths: GraphPath[]) => {
    const todo: { path: GraphPath; signature: string; id: string }[] = []
    const saved: Result[] = []
    for (const p of paths) {
      const signature = pathSignature(p)
      if (results.has(signature)) continue
      const entry = manifest.entries[signature]
      const id = entry?.id ?? newId()
      if (entry && !options.regenerate && (entry.kind === 'impossible' || (entry.file && existsSync(path.join(context.testDir, entry.file))))) {
        const row: Result = { path: p, signature, id, status: entry.kind === 'impossible' ? 'untestable' : 'unverified', file: entry.file, note: entry.kind === 'impossible' ? untestableNote(entry.reason ?? '') : undefined }
        results.set(signature, row)
        if (row.file && row.status !== 'untestable') saved.push(row)
      } else {
        todo.push({ path: p, signature, id })
        results.set(signature, { path: p, signature, id, status: 'unverified', note: writer ? undefined : 'No test yet. Writing one needs Anthropic credentials.' })
      }
    }

    // Saved tests first: they cost nothing, and a working one is an example for new ones.
    await runAndRepair(saved, new Set())
    if (!writer || !todo.length) return
    // With no working example yet, write a batch on its own first, so the rest can
    // learn from it. If none of that batch works, try one more before the rest.
    const size = options.batchSize ?? 5
    let rest = todo
    for (let warmup = 0; warmup < 2 && !example.code && rest.length > size; warmup++) {
      await writeAndRun(rest.slice(0, size))
      rest = rest.slice(size)
    }
    await writeAndRun(rest)
  }

  const record = (t: { signature: string; id: string }, answer: TestAnswer | undefined) => {
    const result = results.get(t.signature)!
    if (!answer) {
      result.note = "The test writer didn't answer for this path."
      return
    }
    if (answer.kind === 'impossible') {
      const conflict = answer.conflict.flatMap((c) => {
        const node = ids.toFull.get(c.box)
        const edge = node ? flow.edges.find((e) => e.from === node && e.label === c.answer)?.label : undefined
        return node && edge ? [{ node, edge }] : []
      })
      manifest.entries[t.signature] = { id: t.id, kind: 'impossible', reason: answer.reason, conflict, code: codeHash, writtenAt: new Date().toISOString() }
      Object.assign(result, { status: 'untestable', note: untestableNote(answer.reason), file: undefined })
      return
    }
    const file = `${t.id}-${t.signature}.test.ts`
    writeFileSync(path.join(context.testDir, file), answer.code.trimEnd() + '\n')
    manifest.entries[t.signature] = { id: t.id, kind: 'test', file, writtenAt: new Date().toISOString() }
    Object.assign(result, { file, status: 'unverified', note: undefined })
  }

  const apply = (rows: Result[], outcomes: Map<string, TestOutcome>, fresh: Set<string>) => {
    for (const r of rows) {
      const file = path.join(context.testDir, r.file!)
      const o = outcomes.get(file)
      if (!o) continue
      // Only a file with exactly one test that recorded one call is evidence.
      const trace = o.status === 'broken' ? undefined : readTrace(file)
      if (!trace) {
        const note =
          o.status === 'passed'
            ? "The test passed without calling the function through run(), so Vantle couldn't see the route."
            : `The test broke before reaching the function: ${o.message}`
        Object.assign(r, { status: 'unverified', note })
        continue
      }
      traces.set(file, trace)
      // The route the code took decides the status, not what the test asserted.
      const check = checkRoute(flow, table, { id: r.id, steps: r.path.steps, outcome: r.path.outcome, status: 'unverified' }, trace)
      const mocked = check.kind === 'failed' && check.skipped ? mockedCharted(flow, table, vp.root, file, check.skipped, trace) : undefined
      if (mocked) Object.assign(r, { status: 'unverified', note: mocked })
      else if (check.kind === 'verified') {
        Object.assign(r, { status: 'verified', note: check.note })
        const entry = manifest.entries[r.signature]
        if (entry?.kind === 'test') entry.followed = true
      } else if (check.kind === 'failed') Object.assign(r, { status: 'failed', note: check.note })
      else if (check.kind === 'missed' && !fresh.has(r.signature) && manifest.entries[r.signature]?.followed) {
        // A saved test that used to follow this path no longer does: the code changed.
        Object.assign(r, { status: 'failed', note: `This test used to follow the path, but now: ${check.note}` })
      } else Object.assign(r, { status: 'unverified', note: check.kind === 'missed' ? `The test didn't follow its path. ${check.note}` : check.note })
    }
  }

  if (options.allPaths) {
    // Every path, including ones that share answers with a claim, so claims can be disproved.
    await handle(selectPaths(flow, { allPaths: true }))
  } else {
    // Saved tests first, so re-running checks the same paths and costs nothing.
    if (!options.regenerate) {
      const all = enumeratePaths(flowGraph(flow), 100_000).paths
      const saved = all.filter((p) => manifest.entries[pathSignature(p)])
      if (saved.length) await handle(saved)
    }
    // Then new paths, only for arrows no saved test covers. A second round fills
    // gaps left by paths without a test, or whose tests broke.
    for (let round = 0; round < 2; round++) {
      const covered = coveredArrows([...results.values()], ['verified', 'failed'])
      const missing = new Set(arrows(flow.edges).filter((a) => !covered.has(a)))
      if (!missing.size || (round > 0 && !writer)) break
      const picked = selectPaths(flow, { onlyArrows: missing, conflicts: conflicts(), exclude: new Set(results.keys()), limit: round === 0 ? 200 : 10 })
      if (!picked.length) break
      await handle(picked)
    }
    // An arrow that's still on no tested path, because every path through it repeats answers
    // the writer said can't happen together, is listed with that claim, so the gap is explained.
    const explained = coveredArrows([...results.values()], ['verified', 'failed', 'untestable'])
    const unexplained = new Set(arrows(flow.edges).filter((a) => !explained.has(a)))
    if (unexplained.size) {
      const graph = flowGraph(flow)
      const claims = conflicts()
      for (const p of selectPaths(flow, { onlyArrows: unexplained, exclude: new Set(results.keys()), limit: 20 })) {
        const claim = claims.find((c) => hasConflict(graph, p, c))
        if (!claim) continue
        const signature = pathSignature(p)
        results.set(signature, { path: p, signature, id: newId(), status: 'untestable', note: `Not tested: it needs answers the test writer said can't happen together. ${untestableNote(claim.reason)}` })
      }
    }
  }

  refuteUntestable(flow, table, manifest, results, [...traces.values()])

  const completeness = await checkCompleteness({
    codeHash,
    flow,
    table,
    targets,
    // Only tests that followed their path count: a run that left the chart says nothing about where the chart holds.
    accepted: [...results.values()].flatMap((r) => (r.status === 'verified' && r.file ? [traces.get(path.join(context.testDir, r.file))!] : [])).filter(Boolean),
    manifest,
    writer,
    options,
    usage,
    testsRoot,
    context,
    ids,
    newId: counter('r'),
    projectRoot: vp.root,
    example: shown(),
  })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const rows = [...results.values()]
  const verifiedArrows = coveredArrows(rows, ['verified'])
  const counts: Record<PathStatus, number> = { verified: 0, failed: 0, untestable: 0, unverified: 0 }
  for (const r of rows) counts[r.status]++
  const paths: FlowPath[] = rows.map((r) => ({
    id: r.id,
    steps: r.path.steps,
    outcome: r.path.outcome,
    status: r.status,
    signature: r.signature,
    test: r.file ? relPath(vp.root, path.join(context.testDir, r.file)) : undefined,
    note: r.note,
  }))
  const verification: Verification = {
    verifiedAt: new Date().toISOString(),
    arrowsVerified: verifiedArrows.size,
    arrowsTotal: arrows(flow.edges).length,
    counts,
    codeChanged: options.codeChanged ?? false,
    outOfDate: table.missing.size > 0,
    generatedTests: usage.generated,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: Date.now() - started,
    completeness,
    spend: usage.spend,
  }
  return { ...flow, paths, pathsTruncated: false, verification } as AnyFlow
}

/**
 * When a test mocks a module or helper the chart draws, the box's code never
 * runs, which looks like a branch missing from the chart. Returns a note saying
 * so, or undefined when the test didn't mock where the skipped box lives.
 */
function mockedCharted(flow: AnyFlow, table: ProbeTable, root: string, testFile: string, nodeId: string, trace: Trace): string | undefined {
  const node = flow.nodes.find((n) => n.id === nodeId)
  if (!node) return undefined
  const code = readFileSync(testFile, 'utf8')
  const bare = (file: string) => file.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '')
  const files = new Set((table.byNode.get(nodeId) ?? []).map((id) => bare(path.resolve(root, table.probes[id]!.span.file))))
  for (const m of code.matchAll(/vi\.(?:mock|doMock)\(\s*(['"`])([^'"`]+)\1/g)) {
    const spec = m[2]!
    if (spec.startsWith('.') && files.has(bare(path.resolve(path.dirname(testFile), spec)))) {
      return `The test mocked '${spec}', which holds ${shortName(node)} from the chart, so that check never ran. Set up its inputs instead of mocking it.`
    }
  }
  const fn = node.source.symbol
  for (const m of code.matchAll(/vi\.spyOn\([^,]+,\s*(['"`])([^'"`]+)\1/g)) {
    const name = m[2]!
    if (fn === name || fn.endsWith(`.${name}`)) {
      return `The test mocked \`${name}\`, whose checks are drawn in the chart, so ${shortName(node)} never ran. Set up its inputs instead of mocking it.`
    }
  }
  // Mocks in forms not matched above (a partial mock, a re-exporting module): the
  // box's function never ran, and the test mocks something, so don't blame the chart.
  if (!entered(table, trace, `${node.source.file}#${fn}`) && /vi\.(?:mock|doMock|spyOn)\(/.test(code)) {
    return `The code never entered \`${fn}\`, which the chart draws, and the test mocks a module. It probably mocked \`${fn}\`; set up its inputs instead.`
  }
  return undefined
}

function shortName(node: AnyFlow['nodes'][number]): string {
  return 'label' in node && node.label ? `"${node.label}"` : `\`${node.rawLabel}\``
}

function untestableNote(reason: string): string {
  return `Couldn't build a test. The test writer said: ${reason}`
}

/** Hash of every file the chart's code is in, so saved claims about that code expire when it changes. */
function chartedCodeHash(vp: VantleProject, flow: AnyFlow): string {
  const files = new Set([flow.flow.entry.file, ...(flow.scope ?? []).map((s) => s.file)])
  for (const n of flow.nodes) if ((n.kind === 'decision' || n.kind === 'outcome') && n.spans) for (const s of n.spans) files.add(s.file)
  const parts = [...files].sort().map((f) => {
    const abs = path.join(vp.root, f)
    return `${f}\0${existsSync(abs) ? readFileSync(abs, 'utf8') : ''}`
  })
  return shortHash(parts.join('\0'), 16)
}

/**
 * A path the writer said can't happen, because some answers conflict, is
 * disproved when any test run gave all of those answers. The claim is
 * dropped, so the next run writes a test for it.
 */
function refuteUntestable(flow: AnyFlow, table: ProbeTable, manifest: Manifest, results: Map<string, Result>, traces: Trace[]) {
  // Any single run of the code, whether or not its test followed its own path, shows answers that can happen together.
  const runs = traces
    .filter((t) => (t.calls ?? 1) === 1)
    .map((t) => new Set(routeTaken(flow, table, t).map((s) => arrowKey(s.node, s.edge))))
  for (const [signature, e] of Object.entries(manifest.entries)) {
    if (e.kind !== 'impossible' || !e.conflict?.length) continue
    const by = runs.find((arrowsTaken) => e.conflict!.every((c) => arrowsTaken.has(arrowKey(c.node, c.edge))))
    if (!by) continue
    delete manifest.entries[signature]
    const row = results.get(signature)
    if (row?.status === 'untestable') {
      Object.assign(row, { status: 'unverified', note: `The test writer said this path can't happen (${e.reason ?? ''}), but a test run gave those same answers. A new test will be written next run.` })
    }
  }
}

function coveredArrows(rows: Result[], statuses: PathStatus[]): Set<string> {
  return new Set(rows.filter((r) => statuses.includes(r.status)).flatMap((r) => r.path.steps.map((s) => arrowKey(s.node, s.edge))))
}

function spec(flow: AnyFlow, ids: ReturnType<typeof shortIds>, p: GraphPath, id: string, signature: string): PathSpec {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]))
  const label = (nodeId: string) => {
    const n = byId.get(nodeId)
    return n && 'label' in n ? String(n.label) : undefined
  }
  const outcome = byId.get(p.outcome)
  return {
    id,
    signature,
    steps: p.steps.map((s) => {
      const n = byId.get(s.node)
      return { box: ids.toShort.get(s.node) ?? s.node, code: n?.rawLabel ?? '', label: label(s.node), answer: s.edge, loop: n?.kind === 'decision' ? n.loop : undefined }
    }),
    outcome: { box: ids.toShort.get(p.outcome) ?? p.outcome, value: outcome?.kind === 'outcome' ? outcome.value : '', label: label(p.outcome) },
  }
}

async function writeTests(
  writer: TestWriter,
  flow: AnyFlow,
  context: ReturnType<typeof testContext>,
  ids: ReturnType<typeof shortIds>,
  items: { id: string; spec?: PathSpec; target?: TargetSpec; repair?: { id: string; code: string; error: string } }[],
  options: VerifyOptions,
  usage: Usage,
  phase: keyof Spend,
  example?: TestExample,
): Promise<Map<string, TestAnswer>> {
  // VANTLE_DEBUG=1 prints why each test needed a repair, to see what trips the writer up.
  if (process.env.VANTLE_DEBUG) {
    for (const item of items) if (item.repair) process.stderr.write(`  repair ${item.id}: ${item.repair.error.split('\n')[0]?.slice(0, 300)}\n`)
  }
  const boxes = flow.nodes
    .filter((n) => n.kind === 'decision')
    .map((n) => ({ box: ids.toShort.get(n.id) ?? n.id, code: n.rawLabel, label: 'label' in n ? String(n.label) : undefined }))
  const size = options.batchSize ?? 5
  const batches: (typeof items)[] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))

  const answers = new Map<string, TestAnswer>()
  const queue = [...batches]
  const runBatch = async (batch: typeof items) => {
    const request: TestRequest = {
      flow,
      context,
      boxes,
      paths: batch.flatMap((b) => (b.spec ? [b.spec] : [])),
      targets: batch.flatMap((b) => (b.target ? [b.target] : [])),
      repairs: batch.flatMap((b) => (b.repair ? [b.repair] : [])),
      example,
    }
    const response = await writer(request)
    const tests = response.answers.filter((a) => a.kind === 'test').length
    for (const target of [usage, usage.spend[phase]]) {
      target.inputTokens += response.inputTokens
      target.outputTokens += response.outputTokens
      target.costUsd = target.costUsd === null || response.costUsd === null ? null : target.costUsd + response.costUsd
    }
    const p = usage.spend[phase]
    p.requests++
    p.tests += tests
    p.cachedTokens += response.cachedTokens ?? 0
    p.cacheWriteTokens += response.cacheWriteTokens ?? 0
    usage.generated += tests
    for (const a of response.answers) answers.set(a.id, a)
  }
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) await runBatch(batch)
  }
  // The first request of a run writes the shared prompt (source code and chart) to
  // the cache. Sending it alone lets every later request read the cache instead of
  // paying to write its own copy.
  const cacheWarm = Object.values(usage.spend).some((p) => p.requests > 0)
  if (!cacheWarm && queue.length > 1) await runBatch(queue.shift()!)
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, queue.length) }, worker))
  return answers
}

function loadManifest(file: string, flowId: string): Manifest {
  if (!existsSync(file)) return { version: 0, flow: flowId, entries: {} }
  const parsed = Manifest.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  return parsed.success && parsed.data.flow === flowId ? parsed.data : { version: 0, flow: flowId, entries: {} }
}


/** Most new tests written per run for code no path test ran. */
const MAX_REACH_TESTS = 20

interface CompletenessInput {
  codeHash: string
  flow: AnyFlow
  table: ProbeTable
  targets: Target[]
  /** Traces of path tests that followed their path. */
  accepted: Trace[]
  manifest: Manifest
  writer: TestWriter | undefined
  options: VerifyOptions
  usage: Usage
  testsRoot: string
  context: ReturnType<typeof testContext>
  ids: ReturnType<typeof shortIds>
  newId: () => string
  projectRoot: string
  /** A working path test, to reuse its setup. */
  example?: TestExample
}

/**
 * Checks the chart isn't missing branches. Path tests only follow the chart, so
 * code the chart doesn't know about is code they never run. For each return,
 * throw or branch that no path test ran, a test is written to reach it, and the
 * chart is walked with the answers the code gave: if the code leaves the chart,
 * the chart is missing a branch.
 */
async function checkCompleteness(input: CompletenessInput): Promise<Completeness> {
  const { flow, table, targets, accepted, manifest, writer, options, usage, testsRoot, context } = input
  // Only places reached in runs the chart follows count, not ones an earlier, undrawn call of a helper reached.
  const reachedBy = (trace: Trace) => chartedReach(trace, entryKey(flow), table.tied)
  const byPaths = new Set<number>()
  for (const t of accepted) for (const id of reachedBy(t)) byPaths.add(id)
  const uncovered = targets.filter((t) => !byPaths.has(input.table.byTarget.get(t.key)!))

  interface Row {
    target: Target
    id: string
    file?: string
    status: Gap['status'] | 'holds'
    note?: string
  }
  const rows: Row[] = []
  const toWrite: Row[] = []
  for (const target of uncovered) {
    const saved = manifest.entries[`reach:${target.key}`]
    const row: Row = { target, id: saved?.id ?? input.newId(), status: 'untested' }
    rows.push(row)
    if (saved && !options.regenerate && saved.kind === 'impossible') Object.assign(row, { status: 'untestable', note: untestableNote(saved.reason ?? '') })
    else if (saved?.file && !options.regenerate && existsSync(path.join(context.testDir, saved.file))) row.file = saved.file
    else if (table.missing.size) row.note = "The chart is out of date (some boxes' code changed), so no test was written for this. Run `vantle generate`, then verify."
    else if (!writer) row.note = 'No test reached this. Writing one needs Anthropic credentials.'
    else if (toWrite.length >= (options.maxReachTests ?? MAX_REACH_TESTS)) row.note = `No test reached this. Vantle writes at most ${options.maxReachTests ?? MAX_REACH_TESTS} of these tests per run; run verify again for the rest.`
    else toWrite.push(row)
  }

  const targetSpec = (r: Row): TargetSpec => ({ id: r.id, file: r.target.file, line: r.target.line, fn: r.target.fn, code: r.target.code, goal: r.target.goal })
  const record = (r: Row, answer: TestAnswer | undefined) => {
    if (!answer) {
      r.note = "The test writer didn't answer for this."
      return
    }
    const key = `reach:${r.target.key}`
    if (answer.kind === 'impossible') {
      manifest.entries[key] = { id: r.id, kind: 'impossible', reason: answer.reason, code: input.codeHash, writtenAt: new Date().toISOString() }
      Object.assign(r, { status: 'untestable', note: untestableNote(answer.reason), file: undefined })
      return
    }
    const file = `${r.id}-${shortHash(r.target.key)}.test.ts`
    writeFileSync(path.join(context.testDir, file), answer.code.trimEnd() + '\n')
    manifest.entries[key] = { id: r.id, kind: 'test', file, writtenAt: new Date().toISOString() }
    Object.assign(r, { file, status: 'untested', note: undefined })
  }

  if (writer && toWrite.length) {
    const answers = await writeTests(writer, flow, context, input.ids, toWrite.map((r) => ({ id: r.id, target: targetSpec(r) })), options, usage, 'gaps', input.example)
    for (const r of toWrite) record(r, answers.get(r.id))
  }

  /** Runs these rows' tests; returns the ones that broke or missed their target. */
  const runRows = async (list: Row[]): Promise<Row[]> => {
    const outcomes = await runTests(testsRoot, list.map((r) => path.join(context.testDir, r.file!)), flow.flow.slug)
    const broken: Row[] = []
    for (const r of list) {
      const file = path.join(context.testDir, r.file!)
      const outcome = outcomes.get(file)
      const trace = !outcome || outcome.status === 'broken' ? undefined : readTrace(file)
      const probe = table.byTarget.get(r.target.key)!
      if (!trace) {
        const note =
          outcome?.status === 'passed'
            ? "The test passed without calling the function through run(), so Vantle couldn't see where the code went."
            : `The test broke before reaching the function: ${outcome?.message ?? ''}`
        Object.assign(r, { status: 'untested', note })
      } else if (!reachedBy(trace).has(probe)) {
        const threw = trace.result?.threw ? ` The code threw: ${trace.result.message ?? ''}` : ''
        Object.assign(r, { status: 'untested', note: `The test didn't reach line ${r.target.line} (${r.target.goal}).${threw}` })
      } else {
        const check = checkReach(flow, table, trace, r.target)
        const mocked = check.kind === 'gap' && check.skipped ? mockedCharted(flow, table, input.projectRoot, file, check.skipped, trace) : undefined
        if (mocked) Object.assign(r, { status: 'untested', note: mocked })
        else if (check.kind === 'holds') Object.assign(r, { status: 'holds', note: check.note })
        else if (check.kind === 'gap') Object.assign(r, { status: 'missing', note: check.note })
        else Object.assign(r, { status: 'untested', note: check.note })
      }
      if (r.status === 'untested') broken.push(r)
    }
    return broken
  }

  const withTests = rows.filter((r) => r.file)
  const broken = withTests.length ? await runRows(withTests) : []
  // Tests that broke or missed their place get one repair.
  if (writer && broken.length) {
    const repairs = broken.map((r) => ({
      id: r.id,
      target: targetSpec(r),
      repair: { id: r.id, code: readFileSync(path.join(context.testDir, r.file!), 'utf8'), error: r.note ?? '' },
    }))
    const answers = await writeTests(writer, flow, context, input.ids, repairs, options, usage, 'repairs', input.example)
    for (const r of broken) record(r, answers.get(r.id))
    const retry = broken.filter((r) => r.file && r.status === 'untested')
    if (retry.length) await runRows(retry)
  }

  const gaps: Gap[] = rows
    .filter((r) => r.status !== 'holds')
    .map((r) => ({
      id: r.id,
      status: r.status as Gap['status'],
      kind: r.target.kind,
      file: r.target.file,
      line: r.target.line,
      symbol: r.target.fn,
      code: r.target.code,
      test: r.file ? relPath(input.projectRoot, path.join(context.testDir, r.file)) : undefined,
      note: r.note,
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return {
    places: targets.length,
    reachedByPaths: targets.length - uncovered.length,
    reachedOnChart: rows.filter((r) => r.status === 'holds').length,
    gaps,
  }
}

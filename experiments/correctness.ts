// The correctness check: runs small marked functions on many inputs under verify's
// instrumentation, and checks every run against the chart. See docs/design/correctness-check.md.
//
// Usage: npx tsx experiments/correctness.ts [--only a,b] [--json out.json] [--keep] [--extractor <checkout>]
// --extractor charts with another checkout's extractor (say, before a fix), to see what the check would have caught.
//   Only the extractor and project loading come from that checkout; probes and judging are this one's.
//
// Each case is a folder under test/correctness/corpus/<case>/ with:
//   src/...        the project's sources (one function marked with @vantle)
//   inputs.json    the inputs, see `Input` below
//   case.json      optional: { "name": "<function to chart>", "options": { ...extract options } }
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import * as currentExtract from '../src/extract/extract.js'
import type { ExtractOptions } from '../src/extract/extract.js'
import * as currentProject from '../src/project.js'
import type { RawFlow } from '../src/schema/flow.js'
import { testContext } from '../src/verify/context.js'
import { coverageTargets, functionEntries, type Target } from '../src/verify/coverage.js'
import { relPath } from '../src/project.js'
import { SyntaxKind } from 'ts-morph'
import { judgeRun, type Verdict } from '../src/verify/judge.js'
import { addEntryProbes, addReachProbes, probeTable, type Trace } from '../src/verify/route.js'
import { prepareTestRoot, writeProbes } from '../src/verify/run.js'

/**
 * One input, as data, so a failing one can be printed and replayed:
 *   { "args": [spec, ...], "this"?: spec, "globals"?: { "<name>": spec }, "shared"?: { "<name>": spec } }
 * Or many at once, every combination of the listed options:
 *   { "each": [[spec, ...], [spec, ...]], "this"?: [spec, ...], "globals"?: { "<name>": [spec, ...] } }
 * A spec is plain JSON, or one of:
 *   { "$undefined": true }                      undefined
 *   { "$fn": spec }                             a function that returns spec, the same value every call (a lookup)
 *   { "$fnFresh": spec }                        a function that builds spec anew on each call
 *   { "$fnSeq": [spec, ...] }                   a function that returns each in turn, then the last
 *   { "$throws": "message" }                    a function that throws
 *   { "$async": spec }                          a resolved promise
 *   { "$new": "Class", "args": [spec, ...] }    new Class(...args), Class exported by the entry file
 *   { "$proto": "Class", "fields": { ... } }    an object of that class, without running its constructor
 *   { "$set": [spec, ...] }                     a Set
 *   { "$ref": "name" }                          the input's `shared` value of that name: one object, wherever it's used
 */
type Spec = unknown
type Input = { args: Spec[]; this?: Spec; globals?: Record<string, Spec>; shared?: Record<string, Spec> }
type Many = { each: Spec[][]; this?: Spec[]; globals?: Record<string, Spec[]>; shared?: Record<string, Spec> }

const CORPUS = path.resolve(import.meta.dirname, '../test/correctness/corpus')
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src'],
})
const RUN_LIMIT_MS = Number(process.env.CORRECTNESS_LIMIT_MS ?? 5 * 60_000)

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const only = flag('--only')?.split(',')
const jsonOut = flag('--json')
const keep = args.includes('--keep')
const other = flag('--extractor')
const { DEFAULT_EXTRACT_OPTIONS, extractFlow } = (other ? await import(path.resolve(other, 'src/extract/extract.ts')) : currentExtract) as typeof currentExtract
const { findAnnotations, flowSlug, loadProject } = (other ? await import(path.resolve(other, 'src/project.ts')) : currentProject) as typeof currentProject

function expand(raw: Input | Many): Input[] {
  if (!('each' in raw)) return [raw]
  const product = <T>(lists: T[][]): T[][] => lists.reduce<T[][]>((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]])
  const globalNames = Object.keys(raw.globals ?? {})
  const thisOptions = raw.this ?? [undefined]
  const out: Input[] = []
  for (const argList of product(raw.each))
    for (const self of thisOptions)
      for (const g of product(globalNames.map((n) => raw.globals![n]!)))
        out.push({
          args: argList,
          ...(self !== undefined ? { this: self } : {}),
          ...(globalNames.length ? { globals: Object.fromEntries(globalNames.map((n, i) => [n, g[i]])) } : {}),
          ...(raw.shared ? { shared: raw.shared } : {}),
        })
  return out
}

// Written into the generated test: turns specs into values.
const BUILD_SOURCE = `
let shared: Record<string, any> = {}
let sharedBuilt: Map<string, any> = new Map()
function build(spec: any, mod: any): any {
  if (Array.isArray(spec)) return spec.map((s) => build(s, mod))
  if (spec === null || typeof spec !== 'object') return spec
  if (spec.$undefined) return undefined
  if ('$ref' in spec) {
    if (!sharedBuilt.has(spec.$ref)) sharedBuilt.set(spec.$ref, build(shared[spec.$ref], mod))
    return sharedBuilt.get(spec.$ref)
  }
  if ('$set' in spec) return new Set(build(spec.$set, mod))
  if ('$fn' in spec) {
    let made = false
    let value: any
    return () => (made ? value : ((made = true), (value = build(spec.$fn, mod))))
  }
  if ('$fnFresh' in spec) return () => build(spec.$fnFresh, mod)
  if ('$fnSeq' in spec) {
    let i = 0
    return () => build(spec.$fnSeq[Math.min(i++, spec.$fnSeq.length - 1)], mod)
  }
  if ('$throws' in spec) return () => { throw new Error(spec.$throws) }
  if ('$async' in spec) return Promise.resolve(build(spec.$async, mod))
  if ('$new' in spec) return new mod[spec.$new](...build(spec.args ?? [], mod))
  if ('$proto' in spec) return Object.assign(Object.create(mod[spec.$proto].prototype), build(spec.fields ?? {}, mod))
  return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, build(v, mod)]))
}
`

function testSource(specifier: string, symbol: string, inputs: Input[], outDir: string): string {
  // `Class.method`: the class is everything before the last dot.
  const dot = symbol.lastIndexOf('.')
  const [owner, method] = dot >= 0 ? [symbol.slice(0, dot), symbol.slice(dot + 1)] : [undefined, symbol]
  // An instance method when the input gives `this`, otherwise a static one.
  const target = owner
    ? `(self: any) => { const C = ${JSON.stringify(owner)}.split('.').reduce((o: any, k: string) => o?.[k], mod); return self === undefined ? [C, C[${JSON.stringify(method)}]] : [self, C.prototype[${JSON.stringify(method)}]] }`
    : `(self: any) => [self, mod[${JSON.stringify(method)}] ?? (mod.default?.name === ${JSON.stringify(method)} ? mod.default : undefined)]`
  return `// Written by experiments/correctness.ts.
import { writeFileSync } from 'node:fs'
import { record } from '../vantle'
import * as mod from ${JSON.stringify(specifier)}
${BUILD_SOURCE}
const inputs: any[] = ${JSON.stringify(inputs)}
const target = ${target}
inputs.forEach((input, i) => {
  test('input ' + i, async () => {
    const g = globalThis as any
    shared = input.shared ?? {}
    sharedBuilt = new Map()
    // Globals the input sets, put back as they were afterwards.
    const names = Object.keys(input.globals ?? {})
    const saved = names.map((n) => Object.getOwnPropertyDescriptor(g, n))
    for (const n of names) Object.defineProperty(g, n, { value: build(input.globals[n], mod), configurable: true, writable: true })
    try {
      const [self, fn] = target(input.this === undefined ? undefined : build(input.this, mod))
      if (typeof fn !== 'function') throw new Error("Vantle: couldn't find the function under test: it isn't exported, or it's a method and the input gives no \`this\`.")
      const values = build(input.args, mod)
      const trace = await record(() => fn.apply(self, values))
      // One file per input, written as soon as it's recorded, so a run that hangs loses only itself.
      writeFileSync(${JSON.stringify(outDir)} + '/' + i + '.json', JSON.stringify(trace))
    } finally {
      names.forEach((n, k) => (saved[k] ? Object.defineProperty(g, n, saved[k]!) : delete g[n]))
    }
  })
})
`
}

// Vitest runs in its own process group (for the watchdog), so Ctrl-C has to be passed on.
let running: number | undefined
process.on('SIGINT', () => {
  if (running !== undefined) {
    try {
      process.kill(-running, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  process.exit(130)
})

/** Where to record entering each catch the chart's not-charted list names. */
function listedCatchTargets(vp: ReturnType<typeof loadProject>, flow: RawFlow): (Target & { clause: { file: string; start: number; end: number } })[] {
  const out: (Target & { clause: { file: string; start: number; end: number } })[] = []
  for (const n of flow.notCharted ?? []) {
    if (n.kind !== 'catch') continue
    const source = vp.sourceFiles.find((f) => relPath(vp.root, f) === n.file)
    for (const c of source?.getDescendantsOfKind(SyntaxKind.CatchClause) ?? []) {
      if (c.getStartLineNumber() !== n.line) continue
      const at = c.getBlock().getStart() + 1
      out.push({
        key: `listed-catch:${n.file}:${c.getStart()}`,
        kind: 'catch',
        file: n.file,
        line: n.line,
        fn: n.symbol,
        code: n.code,
        goal: '',
        insert: { start: at, end: at, wrap: false },
        clause: { file: n.file, start: c.getStart(), end: c.getEnd() },
      })
    }
  }
  return out
}

/** Runs Vitest once on the test file. Returns its output, or a note when it had to be stopped. */
function runVitest(testsRoot: string, slug: string, file: string): Promise<string> {
  const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
  return new Promise((resolve) => {
    // Its own process group, so the watchdog can stop Vitest's workers too.
    const child = spawn(process.execPath, [vitest, 'run', '--root', testsRoot, '--config', path.join(testsRoot, 'vitest.config.mjs'), file], {
      cwd: testsRoot,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', VANTLE_FLOW: slug },
      detached: true,
    })
    running = child.pid
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    // A synchronous endless loop can't be stopped from inside the process.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      text += `\nStopped after ${RUN_LIMIT_MS / 1000} s.`
    }, RUN_LIMIT_MS)
    child.on('close', () => {
      running = undefined
      clearTimeout(timer)
      resolve(text)
    })
  })
}

type CaseResult = {
  case: string
  error?: string
  runs: number
  pass: number
  fail: { input: Input; reason: string; note: string }[]
  unjudged: Record<string, number>
  unjudgedSamples: { input: Input; reason: string; note: string }[]
  missing: number
  arrows: { node: string; label: string; edge: string; taken: number }[]
  offRoute: string[]
  pathsTruncated: boolean
}

async function runCase(name: string): Promise<CaseResult> {
  const dir = path.join(CORPUS, name)
  const empty: CaseResult = { case: name, runs: 0, pass: 0, fail: [], unjudged: {}, unjudgedSamples: [], missing: 0, arrows: [], offRoute: [], pathsTruncated: false }
  const config = existsSync(path.join(dir, 'case.json')) ? (JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8')) as { name?: string; options?: Partial<ExtractOptions> }) : {}
  const inputs = (JSON.parse(readFileSync(path.join(dir, 'inputs.json'), 'utf8')) as (Input | Many)[]).flatMap(expand)

  // Each case gets its own copy, so no two charts instrument the same file.
  const root = mkdtempSync(path.join(os.tmpdir(), `vantle-correctness-${name}-`))
  try {
    cpSync(path.join(dir, 'src'), path.join(root, 'src'), { recursive: true })
    writeFileSync(path.join(root, 'tsconfig.json'), TSCONFIG)
    const vp = loadProject(root)
    const annotations = findAnnotations(vp)
    const annotation = config.name ? annotations.find((a) => a.name === config.name) : annotations[0]
    if (!annotation) return { ...empty, error: 'no marked function' }
    let flow: RawFlow
    try {
      flow = extractFlow(vp, annotation, flowSlug(annotation.name), { ...DEFAULT_EXTRACT_OPTIONS, ...config.options })
    } catch (e) {
      return { ...empty, error: `extraction failed: ${e instanceof Error ? e.message : e}` }
    }
    // Probes as verify builds them: boxes and returns, then every return, throw and catch, then function entries.
    const table = probeTable(flow, (file) => {
      const abs = path.join(vp.root, file)
      return existsSync(abs) ? readFileSync(abs, 'utf8').replace(/^﻿/, '') : undefined
    })
    addReachProbes(table, coverageTargets(vp, flow))
    addEntryProbes(table, functionEntries(vp, flow))
    // A probe at the start of each catch the chart lists as reachable from code it doesn't draw.
    const listed = listedCatchTargets(vp, flow)
    addReachProbes(table, listed)
    const listedCatches = listed.map((t) => ({ probe: table.byTarget.get(t.key)!, ...t.clause }))
    const context = testContext(vp, flow)
    const testsRoot = path.dirname(context.testDir)
    prepareTestRoot(testsRoot)
    mkdirSync(context.testDir, { recursive: true })
    writeProbes(context.testDir, vp.root, table)
    const outDir = path.join(context.testDir, 'traces')
    mkdirSync(outDir, { recursive: true })
    const testFile = path.join(context.testDir, 'correctness.test.ts')
    writeFileSync(testFile, testSource(context.entry.specifier, flow.flow.entry.symbol, inputs, outDir))
    const output = await runVitest(testsRoot, flow.flow.slug, path.relative(testsRoot, testFile))
    const traceOf = (i: number): Trace | undefined => {
      const file = path.join(outDir, `${i}.json`)
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Trace) : undefined
    }

    const result: CaseResult = { ...empty, runs: inputs.length, pathsTruncated: flow.pathsTruncated }
    const taken = new Map<string, number>()
    const offRoute = new Set<string>()
    inputs.forEach((input, i) => {
      const trace = traceOf(i)
      if (!trace) {
        result.missing++
        return
      }
      const judged = judgeRun(flow, table, trace, { listedCatches })
      for (const s of judged.route) taken.set(`${s.node}|${s.edge}`, (taken.get(`${s.node}|${s.edge}`) ?? 0) + 1)
      for (const n of judged.offRoute) offRoute.add(n)
      const v: Verdict = judged.verdict
      if (v.kind === 'pass') result.pass++
      else if (v.kind === 'fail') result.fail.push({ input, reason: v.reason, note: v.note })
      else {
        result.unjudged[v.reason] = (result.unjudged[v.reason] ?? 0) + 1
        if (result.unjudgedSamples.filter((s) => s.reason === v.reason).length < 2) result.unjudgedSamples.push({ input, reason: v.reason, note: v.note })
      }
    })
    const label = (id: string) => {
      const n = flow.nodes.find((x) => x.id === id)
      return n && 'rawLabel' in n ? n.rawLabel : id
    }
    const decisions = new Set(flow.nodes.filter((n) => n.kind === 'decision').map((n) => n.id))
    result.arrows = flow.edges.filter((e) => decisions.has(e.from)).map((e) => ({ node: e.from, label: label(e.from), edge: e.label, taken: taken.get(`${e.from}|${e.label}`) ?? 0 }))
    result.offRoute = [...offRoute].map(label)
    // A case where nothing could be judged, or some runs recorded nothing, says nothing about its chart.
    if (result.missing) result.error = `${result.missing} of ${inputs.length} runs recorded nothing:\n${output.slice(-1500)}`
    else if (!result.pass && !result.fail.length) result.error = 'No run could be judged.'
    return result
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.log(`kept ${root}`)
  }
}

const cases = readdirSync(CORPUS).filter((c) => existsSync(path.join(CORPUS, c, 'inputs.json')) && (!only || only.includes(c))).sort()
const results: CaseResult[] = []
for (const c of cases) {
  const r = await runCase(c)
  results.push(r)
  const untaken = r.arrows.filter((a) => !a.taken)
  const unjudged = Object.entries(r.unjudged).map(([k, n]) => `${k} ${n}`).join(', ')
  const status = r.fail.length ? 'FAIL' : r.error ? 'ERROR' : r.unjudged.unexpected ? 'WARN' : 'ok  '
  console.log(`\n${status} ${c}: ${r.runs} runs, ${r.pass} pass, ${r.fail.length} fail${unjudged ? `, unjudged: ${unjudged}` : ''}${r.missing ? `, ${r.missing} not recorded` : ''}${r.pathsTruncated ? ', path list truncated' : ''}`)
  if (r.error) console.log(`  ${r.error.split('\n').join('\n  ')}`)
  for (const f of r.fail.slice(0, 3)) console.log(`  fail (${f.reason}): ${f.note}\n    input: ${JSON.stringify(f.input)}`)
  for (const s of r.unjudgedSamples) console.log(`  unjudged (${s.reason}): ${s.note}\n    input: ${JSON.stringify(s.input)}`)
  if (untaken.length) console.log(`  arrows no run took: ${untaken.map((a) => `\`${a.label}\` ${a.edge}`).join('; ')}`)
  if (r.offRoute.length) console.log(`  evaluated off the route (not failed): ${r.offRoute.map((l) => `\`${l}\``).join('; ')}`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2) + '\n')
const failed = results.filter((r) => r.fail.length || r.error)
const warned = results.filter((r) => !r.fail.length && !r.error && r.unjudged.unexpected)
console.log(`\n${results.length} cases, ${failed.length} with failures or errors, ${warned.length} with unexpected unjudged runs (WARN).`)
process.exitCode = failed.length ? 1 : 0

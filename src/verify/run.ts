import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ProbeTable, Trace } from './route.js'

const HELPER_SOURCE = `// Written by Vantle. Generated path tests import these helpers.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type Last = { p: number; v: unknown; settled: boolean; i?: number }
type Global = {
  __vantleTrace?: unknown[]
  __vantleCalls?: number
  __vantleFiles?: Set<string>
  __vantleLast?: Last
  __vantleRuns?: { next: number; pending: unknown[]; list: unknown[] }
  expect?: { getState(): { testPath?: string } }
}

/**
 * Calls the function under test once and records what it did: the answer at
 * every box in the chart and the result. Vantle checks the route itself, so the
 * test doesn't need to assert the outcome.
 */
export function run<T>(call: () => T): T {
  const g = globalThis as Global
  g.__vantleCalls = (g.__vantleCalls ?? 0) + 1
  return capture(call, save) as T
}

/**
 * Calls the function once and hands back what it recorded instead of saving it,
 * so one test can run the function on many inputs, one after another.
 */
export function record(call: () => unknown): Promise<Recorded> {
  const g = globalThis as Global
  g.__vantleCalls = 1
  // Settles when the run has finished, however the code's promise (or thenable) behaves.
  return new Promise((resolve) => void capture(call, resolve))
}

export type Recorded = { events: unknown[]; result: unknown; calls?: number; files: string[]; invocations: unknown[] }

function save(trace: Recorded) {
  const testPath = (globalThis as Global).expect?.getState().testPath
  if (!testPath) return
  const dir = path.join(path.dirname(testPath), '.traces')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, path.basename(testPath) + '.json'), JSON.stringify(trace))
}

function capture(call: () => unknown, done: (trace: Recorded) => void): unknown {
  const g = globalThis as Global
  const events: unknown[] = []
  g.__vantleTrace = events
  g.__vantleLast = undefined
  // Run ids keep counting, so async work left over from an earlier call, which can still
  // record into this trace, is never taken for a run of this one.
  g.__vantleRuns = g.__vantleRuns ? { next: g.__vantleRuns.next, pending: [], list: [] } : undefined
  // Which charted return or throw produced the result: the last one that ran,
  // if what it handed back is exactly what the function returned or threw.
  const source = (result: unknown) => {
    const last = g.__vantleLast
    return last && last.settled && Object.is(last.v, result) ? { probe: last.p, ...(last.i !== undefined ? { probeRun: last.i } : {}) } : {}
  }
  const end = (result: unknown) =>
    done({ events, result, calls: g.__vantleCalls, files: [...(g.__vantleFiles ?? [])], invocations: g.__vantleRuns?.list ?? [] })
  const finish = (value: unknown) => {
    g.__vantleTrace = undefined
    end(value === undefined ? { undefined: true, ...source(value) } : { value: plain(value), ...source(value) })
    return value
  }
  const fail = (error: unknown) => {
    g.__vantleTrace = undefined
    end({ threw: true, message: error instanceof Error ? error.message : String(error), ...source(error) })
    return undefined
  }
  let value: unknown
  try {
    value = call()
  } catch (error) {
    return fail(error)
  }
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    return (value as Promise<unknown>).then(finish, fail)
  }
  return finish(value)
}

function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}
`

const SETUP_SOURCE = `// Written by Vantle. Records what instrumented code does during a path test.
const g = globalThis as Record<string, any>

function value(v: unknown): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return v === undefined ? '__undefined' : '__object'
}

const thenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === 'function'

// Runs of charted functions. Each charted function's body starts by recording a
// run and keeping its ID in a local, \`__vr\`, which every probe written in that
// body passes along. So what a probe records belongs to the run it happened in,
// even with recursion or async runs that interleave. An inlined call site marks
// itself after its arguments run, just before the call, and the called function's
// entry takes the mark: every run knows the call it came from and the run that made it.
type Run = { id: number; fn: string; site?: number; parent?: number }
type Mark = { site: number; callee: string; parent?: number }
type Runs = { next: number; pending: Mark[]; list: Run[] }
const runs = (): Runs => (g.__vantleRuns ??= { next: 0, pending: [], list: [] })
// A mark waits for its callee's entry. Code that runs in between (the callee's default
// parameters, the expression that gives the callee) can call other charted functions, which
// leave it alone. Once the run that made the mark records anything, the call never arrived.
const clearMark = (i?: number) => {
  const r = runs()
  if (r.pending.length) r.pending = r.pending.filter((m) => m.parent !== i)
}

g.__vantleSite = (id: number, parent: number | undefined, callee: string, value?: unknown, spread?: boolean) => {
  // A spread argument is iterated first, so code in the iterator can't take the mark.
  const out = spread ? [...(value as Iterable<unknown>)] : value
  runs().pending.push({ site: id, callee, ...(parent !== undefined ? { parent } : {}) })
  return out
}
g.__vantleEnter = (id: number, owner: string) => {
  const r = runs()
  const mark = r.pending.at(-1)?.callee === owner ? r.pending.pop() : undefined
  const run: Run = { id: ++r.next, fn: owner, ...(mark ? { site: mark.site, ...(mark.parent !== undefined ? { parent: mark.parent } : {}) } : {}) }
  r.list.push(run)
  g.__vantleTrace?.push({ p: id, reach: true, i: run.id })
  return run.id
}
g.__vantleProbe = (id: number, v: unknown, i?: number) => {
  clearMark(i)
  // A promise is always truthy, so its answer says nothing about what it resolves to.
  g.__vantleTrace?.push(thenable(v) ? { p: id, v: '__promise', i } : { p: id, t: !!v, v: value(v), i })
  return v
}
g.__vantleReturn = (id: number, v: unknown, i?: number) => {
  clearMark(i)
  g.__vantleTrace?.push({ p: id, r: true, i })
  const last = { p: id, v, settled: !thenable(v), i }
  g.__vantleLast = last
  if (thenable(v)) {
    const settle = (result: unknown) => {
      last.v = result
      last.settled = true
    }
    v.then(settle, settle)
  }
  return v
}
g.__vantleReach = (id: number, i?: number) => {
  clearMark(i)
  g.__vantleTrace?.push({ p: id, reach: true, i })
}
// Each instrumented file calls this when it loads, so a test that never ran the
// instrumented code (a mocked module, a file loaded from another path) is caught.
g.__vantleLoaded = (file: string) => {
  ;(g.__vantleFiles ??= new Set()).add(file)
}

beforeEach(() => {
  g.__vantleTrace = undefined
  g.__vantleCalls = 0
})
`

const CONFIG_SOURCE = `// Written by Vantle to run generated path tests.
// The plugin instruments the code under test: every box in the chart records its
// answer, every outcome records that it returned, and every return, throw and
// branch that matters records that it ran. Probes come from
// <flow>/probes.json for the flow named in VANTLE_FLOW.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const flow = process.env.VANTLE_FLOW
const probesFile = flow ? path.join(root, flow, 'probes.json') : ''
const table = probesFile && existsSync(probesFile) ? JSON.parse(readFileSync(probesFile, 'utf8')) : { files: {}, names: {} }

function instrument(code, probes, name) {
  // Offsets come from the TypeScript parser, which doesn't count a byte-order mark.
  if (code.charCodeAt(0) === 0xfeff) code = code.slice(1)
  // A probe in the wrong place changes what the code does, so refuse to instrument
  // a file that no longer matches. The test then breaks, and is reported unverified.
  for (const p of probes) {
    if (p.text !== undefined && code.slice(p.start, p.end) !== p.text) {
      throw new Error('Vantle: the code in ' + name + " doesn't match its chart's probes any more. Run vantle verify again.")
    }
  }
  // Each insert has a position, and the span it opens or closes, so nested
  // inserts at one offset come out in the right order. Reach markers are
  // statements, so they always sit outside the expressions they share an offset with.
  const inserts = []
  // The run of the charted function a probe is written in (see vantle-setup).
  // A name the file doesn't already use, so it can't clash with the code's own names.
  let vr = '__vantleRun'
  while (code.includes(vr)) vr += '_'
  const run = '(typeof ' + vr + " === 'undefined' ? undefined : " + vr + ')'
  for (const p of probes) {
    const owner = JSON.stringify(p.owner ?? null)
    if (p.kind === 'enter') {
      // Before anything else in the body, including reach markers at the same place.
      const enter = 'const ' + vr + ' = globalThis.__vantleEnter(' + p.id + ', ' + owner + ');'
      if (p.wrap) {
        // An arrow function's expression body becomes a block that returns it.
        inserts.push({ pos: p.start, text: '{ ' + enter + ' return (', open: true, other: p.end, outer: 2 })
        inserts.push({ pos: p.end, text: ') }', open: false, other: p.start, outer: 2 })
      } else {
        // The semicolon ends a directive ("use strict") the entry may follow.
        inserts.push({ pos: p.start, text: ';' + enter, open: true, other: Number.MAX_SAFE_INTEGER, outer: 2 })
      }
      continue
    }
    if (p.kind === 'site') {
      // Marked after the arguments run, so a call inside them can't take the mark.
      const mark = 'globalThis.__vantleSite(' + p.id + ', ' + run + ', ' + JSON.stringify(p.callee)
      if (p.lastArg) {
        const [from, to] = [p.start + p.lastArg[0], p.start + p.lastArg[1]]
        const spread = /\\.\\.\\.\\s*$/.test(code.slice(p.start, from))
        inserts.push({ pos: from, text: mark + ', ', open: true, other: to, outer: -1 })
        inserts.push({ pos: to, text: spread ? ', true)' : ')', open: false, other: from, outer: -1 })
      } else {
        // No arguments: an empty spread, which runs after the callee expression and passes nothing.
        inserts.push({ pos: p.end - 1, text: '...' + mark + ', [])', open: true, other: p.end - 1, outer: -1 })
      }
      continue
    }
    if (p.kind === 'reach') {
      const mark = 'globalThis.__vantleReach(' + p.id + ', ' + run + ');'
      if (p.wrap) {
        inserts.push({ pos: p.start, text: '{' + mark, open: true, other: p.end, outer: 1 })
        inserts.push({ pos: p.end, text: '}', open: false, other: p.start, outer: 1 })
      } else {
        inserts.push({ pos: p.start, text: mark, open: true, other: Number.MAX_SAFE_INTEGER, outer: 1 })
      }
      continue
    }
    const fn = p.kind === 'return' ? '__vantleReturn' : '__vantleProbe'
    inserts.push({ pos: p.start, text: 'globalThis.' + fn + '(' + p.id + ', (', open: true, other: p.end, outer: 0 })
    inserts.push({ pos: p.end, text: '), ' + run + ')', open: false, other: p.start, outer: 0 })
  }
  // Insert from the end so earlier offsets stay valid. At one offset, insert openings
  // (innermost first) and then closings (outermost first), which nests them correctly.
  inserts.sort((a, b) => {
    if (a.pos !== b.pos) return b.pos - a.pos
    if (a.open !== b.open) return a.open ? -1 : 1
    return a.open ? a.other - b.other || a.outer - b.outer : a.other - b.other || b.outer - a.outer
  })
  for (const ins of inserts) code = code.slice(0, ins.pos) + ins.text + code.slice(ins.pos)
  return code + '\\n;globalThis.__vantleLoaded?.(' + JSON.stringify(name) + ');\\n'
}

export default {
  plugins: [
    {
      name: 'vantle-probes',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0]
        const probes = table.files[file]
        return probes ? { code: instrument(code, probes, table.names[file]), map: null } : null
      },
    },
  ],
  test: {
    globals: true,
    include: ['*/*.test.ts'],
    testTimeout: 15000,
    restoreMocks: true,
    setupFiles: [path.join(root, 'vantle-setup.ts')],
  },
}
`

/** Writes the shared helper and config into .vantle/tests. */
export function prepareTestRoot(testsRoot: string) {
  mkdirSync(testsRoot, { recursive: true })
  writeFileSync(path.join(testsRoot, 'vantle.ts'), HELPER_SOURCE)
  writeFileSync(path.join(testsRoot, 'vantle-setup.ts'), SETUP_SOURCE)
  writeFileSync(path.join(testsRoot, 'vitest.config.mjs'), CONFIG_SOURCE)
}

/**
 * Writes the probes for one flow, keyed by absolute file path, for the config's
 * plugin. Vite loads files by their real path, so a project opened through a
 * symlink (macOS /tmp, pnpm) is keyed by both.
 */
export function writeProbes(testDir: string, projectRoot: string, table: ProbeTable) {
  const files: Record<string, { id: number; kind: string; start: number; end: number; wrap?: boolean; text?: string; owner?: string; callee?: string }[]> = {}
  const names: Record<string, string> = {}
  for (const p of table.probes) {
    const abs = path.resolve(projectRoot, p.span.file)
    const keys = new Set([abs, realPath(abs)].map((k) => k.split(path.sep).join('/')))
    for (const key of keys) {
      ;(files[key] ??= []).push({
        id: p.id,
        kind: p.kind,
        start: p.span.start,
        end: p.span.end,
        ...(p.wrap ? { wrap: true } : {}),
        ...(p.kind !== 'reach' && p.span.text !== undefined ? { text: p.span.text } : {}),
        ...(p.owner ? { owner: p.owner } : {}),
        ...(p.callee ? { callee: p.callee } : {}),
        ...(p.span.lastArg ? { lastArg: p.span.lastArg } : {}),
      })
      names[key] = p.span.file
    }
  }
  writeFileSync(path.join(testDir, 'probes.json'), JSON.stringify({ files, names }, null, 2) + '\n')
}

function realPath(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** The trace a test recorded through run(), if it did. */
export function readTrace(testFile: string): Trace | undefined {
  const file = path.join(path.dirname(testFile), '.traces', path.basename(testFile) + '.json')
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as Trace
}

export interface TestOutcome {
  /** Test file path, absolute. */
  file: string
  /** broken: the file didn't load, didn't run, or doesn't hold exactly one test. */
  status: 'passed' | 'failed' | 'broken'
  message: string
}

/** Runs the given test files with Vitest and reports how each one ended. */
export async function runTests(testsRoot: string, files: string[], flowSlug?: string): Promise<Map<string, TestOutcome>> {
  const results = new Map<string, TestOutcome>()
  if (!files.length) return results
  const report = path.join(testsRoot, '.last-run.json')
  rmSync(report, { force: true })
  for (const f of files) rmSync(path.join(path.dirname(f), '.traces', path.basename(f) + '.json'), { force: true })

  const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
  const relFiles = files.map((f) => path.relative(testsRoot, f).split(path.sep).join('/'))
  const output = await new Promise<string>((resolve) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--root', testsRoot, '--config', path.join(testsRoot, 'vitest.config.mjs'), '--reporter=json', `--outputFile=${report}`, ...relFiles],
      { cwd: testsRoot, env: { ...process.env, FORCE_COLOR: '0', ...(flowSlug ? { VANTLE_FLOW: flowSlug } : {}) } },
    )
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('close', () => resolve(text))
  })

  if (!existsSync(report)) {
    for (const f of files) results.set(f, { file: f, status: 'broken', message: `Vitest didn't produce results:\n${output.slice(-3000)}` })
    return results
  }
  const json = JSON.parse(readFileSync(report, 'utf8')) as {
    testResults: { name: string; status: string; message?: string; assertionResults: { status: string; failureMessages: string[] }[] }[]
  }
  // Vitest reports real paths, which differ from ours when the project is opened through a symlink.
  const byRealPath = new Map(files.map((f) => [realPath(f), f]))
  for (const file of json.testResults) {
    const reported = path.resolve(testsRoot, file.name)
    const abs = byRealPath.get(realPath(reported)) ?? reported
    const tests = file.assertionResults
    const failures = tests.flatMap((t) => t.failureMessages)
    let outcome: TestOutcome
    if (tests.length === 0) {
      outcome = { file: abs, status: 'broken', message: file.message || 'The file has no tests, or failed to load.' }
    } else if (tests.length > 1) {
      outcome = { file: abs, status: 'broken', message: 'A path test must contain exactly one test.' }
    } else if (tests[0]!.status === 'passed') {
      outcome = { file: abs, status: 'passed', message: '' }
    } else {
      const message = failures.join('\n') || file.message || 'Test failed.'
      outcome = { file: abs, status: 'failed', message: cleanMessage(message) }
    }
    results.set(abs, outcome)
  }
  for (const f of files) {
    if (!results.has(f)) results.set(f, { file: f, status: 'broken', message: 'Vitest did not run this file.' })
  }
  return results
}

/** First lines of an error, without long stack traces. */
function cleanMessage(message: string): string {
  return message
    .split('\n')
    .filter((line, i) => i < 3 || !/^\s+at /.test(line))
    .slice(0, 12)
    .join('\n')
}

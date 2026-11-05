import path from 'node:path'
import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type Expression,
  type ParameterDeclaration,
  type SourceFile,
  type Statement,
  type SwitchStatement,
} from 'ts-morph'
import { enumeratePaths, toGraph } from '../graph/paths.js'
import { functionName, relPath, type Annotation, type FunctionLike, type VantleProject } from '../project.js'
import type { CallRef, FlowEdge, FlowNode, NotCharted, RawFlow, SourceRef, Span } from '../schema/flow.js'
import { expressionRanges, occurrences, type Ranges } from '../spans.js'
import { normalizeCode, shortHash } from '../util.js'
import { categorize } from './category.js'
import { changeKey, ChangeModel, MUTATING_METHODS, NON_MUTATING_METHODS, mayHold, outsideVariable, pureCall, VOLATILE_CALL, type Change } from './changes.js'
import { callOrigin, hasBranching, isFunctionLike, resolveCallee } from './resolve.js'

export interface ExtractOptions {
  /** How many levels of calls to follow into other functions. */
  depth: number
  /**
   * A helper that would add more boxes than this stays as one box. Keeps generic
   * machinery (rule engines, parsers) from drowning the decision being charted.
   */
  maxInline?: number
  /** Stop listing paths after this many. */
  maxPaths: number
  /** Skip listing and counting paths, for when only the chart's shape is needed. */
  skipPaths?: boolean
  /**
   * When branches that set variables differently rejoin, and keeping them apart
   * would draw more than this many boxes twice, the checks after the join are
   * drawn once and each branch gets a step box showing what it set.
   */
  maxDuplicates?: number
  /**
   * A chart with more boxes than this follows helpers less deep, when that
   * brings it under: the deepest depth that fits is used, and the helpers
   * beyond it are shown as one box each. A chart too big even at depth 1 is
   * drawn in full, since collapsing helpers wouldn't make it readable.
   */
  maxBoxes?: number
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = { depth: 8, maxPaths: 64, maxInline: 40, maxDuplicates: 3, maxBoxes: 50 }

/** Paths are counted up to this many even when only --max-paths are stored. */
const PATH_COUNT_LIMIT = 100_000

/** What a `return` means in the function being walked. */
type Exit =
  /** Returns pick a branch: truthy goes to `yes`, falsy to `no`. */
  | { kind: 'branch'; yes: string; no: string }
  /** Returns end the flow with that value. */
  | { kind: 'value' }

interface Arg {
  text: string
  simple: boolean
  /** When the argument is a variable shown by name or changed before the call: what tells it apart. */
  key?: string
  versions?: Readonly<Record<string, string>>
  /** Changes to the variable earlier in the caller, before this call. */
  changes?: { path: string; at: number }[]
}

/** One function being walked, possibly inlined into a caller. */
interface Frame {
  fn: FunctionLike
  name: string
  params: Map<ParameterDeclaration, Arg>
  /** ID prefix: where this call was inlined from. Empty for the entry function. */
  prefix: string
  /** The arguments and receiver this call was walked with, so walks with different ones don't share results. */
  argsKey: string
  /** What `this` is in an inlined method: the object it was called on. */
  receiver?: Arg
  /** The call that was inlined, in terms of the entry function, for naming what it returns. */
  callText?: string
  /** The inlined calls this frame sits inside, outermost first; empty for the entry function. */
  via: Span[]
  stack: FunctionLike[]
  depth: number
  /** Changes made before this call, in each caller up the chain (see \`ChangeModel\`). */
  outer?: Change[]
}

interface Ctx {
  frame: Frame
  exit: Exit
  breakTarget?: Cont
  continueTarget?: Cont
  /** Header of the loop being walked, such as `for (const item of items)`. */
  loop?: string
  /** Where `break label` and `continue label` go, by label. */
  labels?: ReadonlyMap<string, Cont>
  /** Inside a `try` with a `catch`: where a throw goes (into the catch), and which catch, for cache keys. */
  catchTarget?: Cont
  catchKey?: string
  /**
   * Inside a \`try\` that code Vantle can't see may throw out of, into a catch: its key.
   * The route into the catch the chart draws isn't the only one, so what checks in the
   * \`try\` settled isn't known in the catch or after it. Those checks are separate questions.
   */
  untrusted?: string
}

/** What a local variable holds at some point: its value as code, or unknown. */
/**
 * `versions`: properties changed through the variable (`x.a = 1` gives `a`; a
 * change to the whole object, like `x.push(...)`, gives `*`), each with where
 * it changed. Checks that read a changed property aren't the same question as
 * checks before the change.
 */
type Value =
  | {
      text: string
      simple: boolean
      /**
       * Set when the variable is shown by its name rather than its value (an
       * object, a long expression): a key that tells different values apart.
       */
      byName?: string
      /** For a parameter: the key of the caller's argument (see \`Arg.key\`), so a change or a join doesn't lose which object it is. */
      argKey?: string
      /** For a value shown by name, what it holds, for step boxes. */
      literal?: string
      /** For an object literal not changed since: its properties, so `cfg.level` reads as its value. */
      props?: Readonly<Record<string, { text: string; simple: boolean }>>
      versions?: Readonly<Record<string, string>>
      /** The constant a name like `Level.High` stands for, as JSON. */
      constant?: string
      /** What tells the expression this value came from apart (its identity), so checks on it carry that. */
      deps?: string
      before?: Value | 'absent'
    }
  | 'unknown'
/** Local variables' values at one point in a function, keyed by declaration. */
type Env = ReadonlyMap<Node, Value>
/** Where control goes next, given the variables' values at that point. */
type Cont = (env: Env) => string

const EMPTY_ENV: Env = new Map()
/** More distinct sets of variable values than this at one statement, and values are widened to unknown. */
const MAX_ENVS_PER_STATEMENT = 6
/** Boxes a helper may add when it's drawn only for the ways it can throw. */
const MAX_THROW_INLINE = 10
/** Re-extractions that widen joins, at most. Each widens every join that still duplicates too much. */
const MAX_WIDEN_PASSES = 40

export function extractFlow(vp: VantleProject, annotation: Annotation, slug: string, options = DEFAULT_EXTRACT_OPTIONS): RawFlow {
  const started = Date.now()
  const flowId = `${relPath(vp.root, annotation.file)}#${annotation.name}`

  let { extractor, result } = extractWidened(vp, flowId, annotation, options)
  const boxes = (r: typeof result) => r.nodes.filter((n) => n.kind === 'decision').length
  const budget = options.maxBoxes ?? Infinity
  if (boxes(result) > budget && result.maxDepth > 1) {
    // Too big: follow helpers less deep, if some depth fits. A lower depth almost
    // always means fewer boxes, so if depth 1 doesn't fit, no other depth is tried.
    // (Not always: a helper over --max-inline at full depth can fit, and be drawn,
    // lower down. Trying every depth would cost an extraction each on the biggest charts.)
    let fits = extractWidened(vp, flowId, annotation, { ...options, depth: 1 })
    let depth = 1
    if (boxes(fits.result) <= budget) {
      for (let d = Math.min(options.depth, result.maxDepth) - 1; d > 1; d--) {
        const tried = extractWidened(vp, flowId, annotation, { ...options, depth: d })
        if (boxes(tried.result) <= budget) {
          fits = tried
          depth = d
          break
        }
      }
      ;({ extractor, result } = fits)
      // The budget set the depth, not --depth, so its own warning replaces "raise --depth".
      for (const w of [...extractor.warnings]) if (w.startsWith('Stopped following calls at depth')) extractor.warnings.delete(w)
      extractor.warnings.add(`Helpers more than ${depth} call${depth === 1 ? '' : 's'} deep are shown as one box each, to keep the chart under ${budget} boxes. Raise --max-boxes to see inside them.`)
    }
  }

  const graph = toGraph(result.root, result.nodes, result.edges)
  const { paths, truncated } = options.skipPaths ? { paths: [], truncated: false } : enumeratePaths(graph, options.maxPaths)
  const pathCount = options.skipPaths ? 0 : truncated ? enumeratePaths(graph, PATH_COUNT_LIMIT).paths.length : paths.length

  return {
    schemaVersion: 0,
    flow: {
      id: flowId,
      slug,
      question: annotation.question,
      entry: extractor.sourceRef(annotation.fn, result.rootFrame),
      returnsBoolean: result.returnsBoolean,
      generatedAt: new Date().toISOString(),
      sourceHash: extractor.sourceHash(),
      extractOptions: {
        depth: options.depth,
        ...(options.maxInline !== undefined && Number.isFinite(options.maxInline) ? { maxInline: options.maxInline } : {}),
        ...(options.maxDuplicates !== undefined ? { maxDuplicates: options.maxDuplicates } : {}),
        ...(options.maxBoxes !== undefined && Number.isFinite(options.maxBoxes) ? { maxBoxes: options.maxBoxes } : {}),
      },
    },
    root: result.root,
    nodes: result.nodes,
    edges: result.edges,
    paths: paths.map((p, i) => ({
      id: `p${String(i + 1).padStart(2, '0')}`,
      steps: p.steps,
      outcome: p.outcome,
      status: 'unverified' as const,
    })),
    pathCount,
    pathsTruncated: truncated,
    warnings: [...extractor.warnings],
    scope: [...extractor.scope.values()],
    notCharted: [...extractor.notCharted.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    run: { durationMs: Date.now() - started },
  }
}

/** Extracts, then draws once what follows each join that duplicates too much, until no join does. */
function extractWidened(vp: VantleProject, flowId: string, annotation: Annotation, options: ExtractOptions) {
  let widenAt = new Map<string, Set<number>>()
  let extractor = new Extractor(vp, flowId, options, widenAt)
  let result = extractor.run(annotation.fn, annotation.name)
  for (let pass = 1; pass < MAX_WIDEN_PASSES; pass++) {
    // Every such join at once: they are usually independent (a run of \`if\`s each
    // setting a field), and widening one per pass would need a pass per join.
    widenAt = new Map(widenAt)
    let grew = false
    for (const join of extractor.duplicatingJoins(options.maxDuplicates ?? DEFAULT_EXTRACT_OPTIONS.maxDuplicates!)) {
      const existing = widenAt.get(join.key)
      if (existing && [...join.vars].every((v) => existing.has(v))) continue
      widenAt.set(join.key, new Set([...(existing ?? []), ...join.vars]))
      grew = true
    }
    if (!grew) break
    extractor = new Extractor(vp, flowId, options, widenAt)
    result = extractor.run(annotation.fn, annotation.name)
  }
  return { extractor, result }
}

class Extractor {
  private readonly nodes = new Map<string, FlowNode>()
  private readonly edges: FlowEdge[] = []
  private readonly files = new Set<SourceFile>()
  /** Expression ranges per file, for telling repeated expressions apart. */
  private readonly ranges = new Map<string, Ranges>()
  private readonly inlined = new Map<string, string>()
  /** Catches some walk reached, and the "unreached" note for each catch, to withdraw if a later walk reaches it. */
  private readonly reachedCatches = new Set<string>()
  private readonly unreachedCatches = new Map<string, string>()
  /** Repo functions that can throw, worked out once each. */
  private readonly throwers = new Map<FunctionLike, boolean>()
  /** Repo functions that may let a throw from code Vantle can't see escape, worked out once each. */
  private readonly unseenThrowers = new Map<FunctionLike, boolean>()
  /** What code can change, for telling a check after a change from the same check before it. */
  private readonly changes = new ChangeModel(
    (fn) => this.isRepoPath(fn.getSourceFile().getFilePath()),
    (file) => relPath(this.vp.root, file),
  )
  private readonly lastUses = new WeakMap<FunctionLike, Map<Node, number>>()
  private readonly propUses = new WeakMap<FunctionLike, Map<Node, Map<string, number>>>()
  private readonly readCache = new WeakMap<FunctionLike, Map<Node, [string, number][]>>()
  private readonly widenPointCache = new Map<string, Map<number, number[]>>()
  /** Where branches with different variable values rejoin, and how many boxes each copy added. */
  private readonly joins = new Map<string, { order: number; sizes: number[]; envs: Env[] }>()
  private decisionCount = 0
  /** How deep inlining went, for the box budget. */
  private maxDepth = 0
  /** Results of walking a statement, by statement and context, then by variable values. */
  private readonly memoCache = new Map<string, Map<string, string>>()
  readonly warnings = new Set<string>()
  /** Functions drawn in the chart: the entry function and helpers followed inline. */
  readonly scope = new Map<FunctionLike, { file: string; name: string }>()
  private readonly changeCache = new WeakMap<FunctionLike, { decl: Node; path: string; at: number }[]>()
  /** Routes added to boxes by reusing an inlined call, so undoing an inlining can take them back. */
  private readonly viaLog: { node: string; route: Span[] }[] = []
  /** For each inlined call: the calls it sits inside, and the boxes it drew, so reusing it elsewhere adds that route. */
  private readonly inlinedVia = new Map<string, { via: Span[]; nodes: Set<string> }>()
  /** Decision boxes by everything that makes them what they are, so identical copies are one box. */
  private readonly shapes = new Map<string, string>()
  /** Code the chart can't show, by kind and position. */
  readonly notCharted = new Map<string, NotCharted>()

  constructor(
    private readonly vp: VantleProject,
    private readonly flowId: string,
    private readonly options: ExtractOptions,
    /** Joins where differing variables are widened, by join key → declaration positions. */
    private readonly widenAt: Map<string, Set<number>> = new Map(),
  ) {}

  /** The joins whose extra copies add more than `limit` boxes, each with the variables whose values differ between the copies. */
  duplicatingJoins(limit: number): { key: string; vars: Set<number> }[] {
    const out: { key: string; vars: Set<number> }[] = []
    for (const [key, j] of this.joins) {
      if (j.sizes.length < 2) continue
      const extra = j.sizes.reduce((a, b) => a + b, 0) - Math.max(...j.sizes)
      if (extra <= limit) continue
      const vars = new Set<number>()
      for (const d of new Set(j.envs.flatMap((e) => [...e.keys()]))) {
        if (new Set(j.envs.map((e) => valueKey(e.get(d)))).size > 1) vars.add(d.getStart())
      }
      if (vars.size) out.push({ key, vars })
    }
    return out
  }

  run(fn: FunctionLike, name: string) {
    const frame: Frame = { fn, name, params: new Map(), prefix: '', argsKey: '', stack: [fn], depth: 0, via: [] }
    this.files.add(fn.getSourceFile())
    this.scope.set(fn, { file: relPath(this.vp.root, fn.getSourceFile()), name })
    const returnsBoolean = fn.getReturnType().isBoolean()
    const exit: Exit = returnsBoolean
      ? { kind: 'branch', yes: this.outcome('true', fn, frame), no: this.outcome('false', fn, frame) }
      : { kind: 'value' }
    const root = this.walkBody(fn, { frame, exit })
    const reachable = this.reachableFrom(root)
    const nodes = [...this.nodes.values()].filter((n) => reachable.has(n.id))
    const edges = this.edges.filter((e) => reachable.has(e.from))
    checkIntegrity(root, nodes, edges)
    return { root, rootFrame: frame, returnsBoolean, nodes, edges, maxDepth: this.maxDepth }
  }

  // ---- statements -------------------------------------------------------

  private walkBody(fn: FunctionLike, ctx: Ctx): string {
    const body = fn.getBody()
    const end: Cont = () => this.fallOff(ctx, fn)
    if (body && Node.isBlock(body)) return this.walkStatements(body.getStatements(), ctx, EMPTY_ENV, end)
    if (body) return this.returnValue(body as Expression, ctx, EMPTY_ENV, body)
    return end(EMPTY_ENV)
  }

  /**
   * Walks statements in order. Each statement gets a continuation for the rest of
   * the block, so assignments can change what later statements see. Results are
   * shared when the variables that are still used later have the same values.
   */
  private walkStatements(statements: Statement[], ctx: Ctx, env: Env, next: Cont): string {
    const conts: Cont[] = []
    const at = (i: number): Cont => {
      if (i >= statements.length) return next
      const stmt = statements[i]!
      return (conts[i] ??= this.memo(ctx, stmt, (e) => this.walkStatement(stmt, ctx, e, at(i + 1))))
    }
    return at(0)(env)
  }

  private walkStatement(stmt: Statement, ctx: Ctx, env: Env, next: Cont): string {
    if (Node.isBlock(stmt)) return this.walkStatements(stmt.getStatements(), ctx, env, next)
    if (Node.isIfStatement(stmt)) {
      const yes = this.walkStatement(stmt.getThenStatement(), ctx, env, next)
      const elseStmt = stmt.getElseStatement()
      const no = elseStmt ? this.walkStatement(elseStmt, ctx, env, next) : next(env)
      if (yes === no) {
        // Both sides end the same way in the chart. If a side does something
        // the chart can't show, say so rather than drop it silently.
        const effect = [stmt.getThenStatement(), elseStmt].map((s) => s && firstEffect(s)).find(Boolean)
        if (effect) {
          this.note('effect', stmt, ctx.frame, `if (${stmt.getExpression().getText()})`, `Both sides end the same way in the chart, but one does something the chart can't follow (\`${oneLine(effect.getText())}\`), so the check isn't drawn.`)
        } else {
          // A side that sets a variable used later (\`if (onSale) price = sale\`) shapes what's built from it,
          // even when the chart can't tell the results apart.
          const lastUse = this.lastUse(ctx.frame.fn)
          const set = [stmt.getThenStatement(), elseStmt].flatMap((s) => (s ? [...assignedIn(s, ctx.frame.fn)] : [])).find((d) => (lastUse.get(d) ?? -1) > stmt.getEnd())
          if (set) this.note('effect', stmt, ctx.frame, `if (${oneLine(stmt.getExpression().getText())})`, `Both sides end the same way in the chart, but one sets \`${declarationName(set)}\`, which is used later, so how it changes the result isn't drawn.`)
        }
      }
      const cond = stmt.getExpression()
      return this.throwingCall(cond, ctx, env, () => this.branchOn(cond, yes, no, ctx, env), this.conditionAtoms(cond)) ?? this.branchOn(cond, yes, no, ctx, env)
    }
    if (Node.isReturnStatement(stmt)) {
      const expr = stmt.getExpression()
      const returned = () => this.returnValue(expr, ctx, env, stmt)
      if (!expr) return returned()
      // A returned call is drawn by returnValue itself; calls inside it (\`return String(assertPos(x))\`) are drawn here.
      const top = unwrap(expr)
      const drawn = ctx.exit.kind === 'branch' ? this.conditionAtoms(expr) : new Set<Node>(Node.isCallExpression(top) ? [top] : [])
      return this.throwingCall(expr, ctx, env, returned, drawn) ?? returned()
    }
    if (Node.isThrowStatement(stmt)) {
      if (ctx.catchTarget) return ctx.catchTarget(env)
      // The thrown expression gets a probe, so verify can tell this throw from any other.
      return this.outcome(`throw ${this.text(stmt.getExpression(), ctx.frame, env)}`, stmt, ctx.frame, stmt.getExpression())
    }
    if (Node.isSwitchStatement(stmt)) {
      const subject = stmt.getExpression()
      return this.throwingCall(subject, ctx, env, () => this.walkSwitch(stmt, ctx, env, next)) ?? this.walkSwitch(stmt, ctx, env, next)
    }
    if (Node.isBreakStatement(stmt)) {
      const label = stmt.getLabel()?.getText()
      const target = label ? ctx.labels?.get(label) : undefined
      if (label && !target) this.warn(`Labeled break in ${ctx.frame.name} is treated as a plain break.`)
      return (target ?? ctx.breakTarget ?? next)(env)
    }
    if (
      Node.isForStatement(stmt) ||
      Node.isForOfStatement(stmt) ||
      Node.isForInStatement(stmt) ||
      Node.isWhileStatement(stmt) ||
      Node.isDoStatement(stmt)
    ) {
      // Follow the body as one representative pass: its checks become boxes, an
      // early return becomes an outcome, and finishing the pass continues past the loop.
      // Variables the body assigns could hold anything once the loop has run.
      const assigned = assignedIn(stmt.getStatement(), ctx.frame.fn)
      // Objects changed in the body could be changed by any pass, so after the loop
      // they carry one "changed in this loop" mark rather than one per place.
      const mutated = mutatedIn(stmt.getStatement(), ctx.frame.fn)
      const afterLoop = (e: Env) => {
        let out = forget(e, assigned)
        for (const [decl, props] of mutated) if (!assigned.has(decl)) out = this.changed(out, decl, props, `loop:${stmt.getStart()}`, ctx.frame)
        return out
      }
      const after: Cont = this.memo(ctx, stmt, (e) => next(afterLoop(e)), 'after')
      const header = loopHeader(stmt)
      const inner: Ctx = { ...ctx, breakTarget: after, continueTarget: after, loop: ctx.loop ? `${ctx.loop}, ${header}` : header }
      const entry = this.walkStatement(stmt.getStatement(), inner, forget(env, assigned), after)
      if (entry !== after(env)) {
        this.warn(`Loop in ${ctx.frame.name} (line ${stmt.getStartLineNumber()}) is shown as one pass over its body: its checks apply to each item.`)
      }
      return entry
    }
    if (Node.isContinueStatement(stmt)) {
      // A loop is drawn as one pass, so continuing an outer loop leaves it, like breaking out of it.
      const label = stmt.getLabel()?.getText()
      return ((label ? ctx.labels?.get(label) : undefined) ?? ctx.continueTarget ?? next)(env)
    }
    if (Node.isTryStatement(stmt)) {
      const handler = stmt.getCatchClause()
      const fin = stmt.getFinallyBlock()
      if (fin && fin.getFirstDescendant((n) => Node.isReturnStatement(n) || Node.isThrowStatement(n) || Node.isIfStatement(n) || Node.isSwitchStatement(n) || Node.isConditionalExpression(n))) {
        this.note('catch', fin, ctx.frame, 'finally', 'The `finally` block isn\'t followed, so what it decides isn\'t drawn.')
      }
      // A catch that only rethrows (\`catch (e) { log(e); throw e }\`) changes nothing: each throw stays its own outcome.
      if (!handler || isRethrow(handler)) return this.walkStatements(stmt.getTryBlock().getStatements(), ctx, env, next)
      // A throw in the try block, or in a helper it calls, goes into the catch, which then
      // carries on as written: past the try, returning, or throwing again. Variables the try
      // block assigns could hold anything by then.
      const assigned = assignedIn(stmt.getTryBlock(), ctx.frame.fn)
      let reached = false
      const catchKey = `${ctx.frame.prefix}${handler.getStart()}`
      // A call Vantle can't see into (\`JSON.parse(text)\`), here or in a helper called here, can
      // also throw into the catch, on a path that isn't drawn. Then checks in the try and in the
      // catch are separate questions from each other and from the rest.
      const unseen = this.unseenThrow(stmt.getTryBlock())
      const catchCtx: Ctx = unseen ? { ...ctx, untrusted: `catch@${catchKey}` } : ctx
      const catchBody: Cont = this.memo(catchCtx, handler, (e) => this.walkStatements(handler.getBlock().getStatements(), catchCtx, forget(e, assigned), next), 'catch')
      const intoCatch: Cont = (e) => {
        reached = true
        // Another walk of this try may have listed the catch as unreached before this one reached it.
        const pending = this.unreachedCatches.get(catchKey)
        if (pending) {
          this.notCharted.delete(pending)
          this.unreachedCatches.delete(catchKey)
        }
        this.reachedCatches.add(catchKey)
        return catchBody(e)
      }
      const untrusted = unseen ? `try@${catchKey}` : ctx.untrusted
      const entry = this.walkStatements(stmt.getTryBlock().getStatements(), { ...ctx, catchTarget: intoCatch, catchKey, ...(untrusted ? { untrusted } : {}) }, env, next)
      // Listed unless every way into the catch is drawn: a throw Vantle can see reached it, and nothing it can't see could throw.
      if (unseen || (!reached && !this.reachedCatches.has(catchKey))) {
        const why = unseen ? `\`${oneLine(unseen.getText()).slice(0, 60)}\` could throw into it, and that path isn't drawn.` : 'No throw Vantle can see reaches it, so it isn\'t drawn.'
        const key = this.note('catch', handler, ctx.frame, oneLine(handler.getText().slice(0, handler.getBlock().getStart() - handler.getStart())), `The \`catch\` is drawn only for the throws Vantle can see. ${why}`)
        if (!unseen) this.unreachedCatches.set(catchKey, key)
      }
      return entry
    }
    if (Node.isLabeledStatement(stmt)) {
      const inner = stmt.getStatement()
      const assigned = assignedIn(inner, ctx.frame.fn)
      const out: Cont = (e) => next(forget(e, assigned))
      const labels = new Map(ctx.labels ?? [])
      labels.set(stmt.getLabel().getText(), out)
      return this.walkStatement(inner, { ...ctx, labels }, env, next)
    }
    if (Node.isVariableStatement(stmt)) {
      const after = this.declare(stmt, ctx, env)
      // Each initializer runs in order (\`const a = 1, b = load(x)\`).
      let chained: () => string = () => next(after)
      for (const decl of [...stmt.getDeclarations()].reverse()) {
        const init = decl.getInitializer()
        if (!init || isFunctionLike(init)) continue
        const rest = chained
        chained = () => this.throwingCall(init, ctx, env, rest) ?? rest()
      }
      return chained()
    }
    if (Node.isExpressionStatement(stmt)) {
      const after = this.assign(stmt.getExpression(), ctx, env)
      return this.throwingCall(stmt.getExpression(), ctx, env, () => next(after)) ?? next(after)
    }
    // Anything else doesn't branch or change tracked variables.
    return next(env)
  }

  /**
   * A call used as a statement (\`assertNotBanned(user)\`, \`await this.validate(input)\`)
   * or to set a variable (\`const { user } = await load(id)\`) whose helper can throw.
   * The helper is drawn inline: its throws become outcomes, and whatever else it
   * does continues to the next statement. Undefined when there's nothing to draw.
   */
  private throwingCall(expr: Expression, ctx: Ctx, env: Env, rest: () => string, drawnElsewhere: Set<Node> = new Set()): string | undefined {
    // Calls inside the arguments run first (\`find({ where: buildQuery(id) })\`), in order.
    const { calls: all, conditional } = this.unconditionalCalls(expr)
    const calls = all.filter((c) => !drawnElsewhere.has(c))
    for (const c of conditional) {
      const fn = resolveCallee(c)
      if (fn && this.isRepoPath(fn.getSourceFile().getFilePath()) && this.canThrow(fn)) {
        this.note('effect', c, ctx.frame, oneLine(c.getText()).slice(0, 120), `\`${functionName(fn)}\` can throw, but it only runs on some paths through \`${oneLine(expr.getText()).slice(0, 60)}\`, and those aren't drawn.`)
      }
    }
    let chained: () => string = rest
    let any = false
    for (const call of [...calls].reverse()) {
      const after = chained
      chained = () => this.throwingOne(call, ctx, env, after) ?? after()
      any = true
    }
    this.noteThrowingCallbacks(expr, ctx)
    return any ? chained() : undefined
  }

  /**
   * Repo calls in \`expr\` that always run when it does, innermost first: not under
   * \`?:\`, \`&&\`, \`||\`, \`??\` or \`?.\`, and not inside a function written there.
   */
  private unconditionalCalls(expr: Expression): { calls: CallExpression[]; conditional: CallExpression[] } {
    const out: CallExpression[] = []
    const conditional: CallExpression[] = []
    const sometimes = (n: Node) => {
      if (Node.isCallExpression(n)) conditional.push(n)
      n.forEachDescendant((d, t) => {
        if (isFunctionLike(d)) t.skip()
        else if (Node.isCallExpression(d)) conditional.push(d)
      })
    }
    const visit = (n: Node) => {
      if (isFunctionLike(n)) return
      if (Node.isConditionalExpression(n)) {
        visit(n.getCondition())
        sometimes(n.getWhenTrue())
        sometimes(n.getWhenFalse())
        return
      }
      if (Node.isBinaryExpression(n)) {
        const op = n.getOperatorToken().getKind()
        if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
          visit(n.getLeft())
          sometimes(n.getRight())
          return
        }
      }
      if (Node.isCallExpression(n) && n.hasQuestionDotToken()) {
        sometimes(n)
        return
      }
      n.forEachChild(visit)
      if (Node.isCallExpression(n)) out.push(n)
    }
    visit(expr)
    return { calls: out, conditional }
  }

  /** The calls a check is made of (\`if (isAllowed(u) && !isBanned(u))\`), which the check draws itself. */
  private conditionAtoms(expr: Expression): Set<Node> {
    const out = new Set<Node>()
    const visit = (n: Node) => {
      let e: Node = n
      while (Node.isParenthesizedExpression(e) || Node.isAwaitExpression(e) || Node.isNonNullExpression(e) || Node.isAsExpression(e) || (Node.isPrefixUnaryExpression(e) && e.getOperatorToken() === SyntaxKind.ExclamationToken)) e = (e as Node & { getExpression?(): Node; getOperand?(): Node }).getExpression?.() ?? (e as import('ts-morph').PrefixUnaryExpression).getOperand()
      if (Node.isBinaryExpression(e) && [SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken].includes(e.getOperatorToken().getKind())) {
        visit(e.getLeft())
        visit(e.getRight())
      } else if (Node.isCallExpression(e)) out.add(e)
    }
    visit(expr)
    return out
  }

  /** A callback passed to a call (\`db.transaction(async (tx) => ...)\`) that throws: what it throws isn't drawn, so say so. */
  private noteThrowingCallbacks(expr: Expression, ctx: Ctx) {
    expr.forEachDescendant((n, traversal) => {
      if (!isFunctionLike(n)) return
      traversal.skip()
      if (!Node.isCallExpression(n.getParent()) || !this.canThrow(n)) return
      this.note('callback', n, ctx.frame, oneLine(n.getParent()!.getText()).slice(0, 120), "A callback here can throw, but what's inside callbacks isn't drawn, so the ways it can throw are missing.")
    })
  }

  private throwingOne(e: CallExpression, ctx: Ctx, env: Env, rest: () => string): string | undefined {
    const fn = resolveCallee(e)
    if (!fn || !this.isRepoPath(fn.getSourceFile().getFilePath())) return undefined
    if (!this.canThrow(fn)) {
      // Throws inside the helper's own callbacks (\`match(x).with(p, () => { throw ... })\`) can still end this call.
      if (throwsInCallbacks(fn)) this.note('callback', e, ctx.frame, oneLine(e.getText()).slice(0, 120), `\`${functionName(fn)}\` can throw from inside a callback, which isn't drawn, so the ways it can throw are missing.`)
      return undefined
    }
    const target = rest()
    // Only the checks that lead to a throw are drawn; a helper with many is listed instead, so it can't swamp the chart.
    const inlined = this.tryInline(e, ctx, env, { kind: 'branch', yes: target, no: target }, Math.min(MAX_THROW_INLINE, this.options.maxInline ?? Infinity), true)
    if (inlined === undefined) {
      this.note('effect', e, ctx.frame, oneLine(e.getText()), `\`${functionName(fn)}\` can throw, but its checks aren't drawn here, so the ways it can throw are missing.`)
      return undefined
    }
    return inlined
  }

  /**
   * Code in \`node\` that Vantle can't see into and that could throw: \`new\`, \`await\`, a call
   * outside the repo, or a call to a repo helper that makes one where its own catch doesn't
   * stop it. Helpers are looked through however deep, so a helper shown as one box or cut off
   * by the depth still counts.
   */
  private unseenThrow(node: Node): Node | undefined {
    return this.scanUnseen(node, new Set(), 0)
  }

  /** Whether a repo function may let a throw from code Vantle can't see escape. Unsure counts as yes. */
  private throwsUnseen(fn: FunctionLike, active: Set<FunctionLike>, depth: number): boolean {
    const known = this.unseenThrowers.get(fn)
    if (known !== undefined) return known
    if (active.has(fn) || depth > 12) return true
    active.add(fn)
    const body = fn.getBody()
    const found = !!body && !!this.scanUnseen(body, active, depth)
    active.delete(fn)
    this.unseenThrowers.set(fn, found)
    return found
  }

  /**
   * The first place under \`root\` where code Vantle can't see could throw, and no catch
   * inside \`root\` stops it. A catch stops what its \`try\` throws only when it can't throw
   * anything itself, directly or through a repo helper. Functions written inside \`root\` are skipped; calling one is followed
   * like any helper.
   */
  private scanUnseen(root: Node, active: Set<FunctionLike>, depth: number): Node | undefined {
    let found: Node | undefined
    const visit = (node: Node, caught: boolean) => {
      if (found || (node !== root && isFunctionLike(node))) return
      if (Node.isTryStatement(node) && node.getCatchClause()) {
        const handler = node.getCatchClause()!
        // It stops them unless it throws, itself or through a repo helper that can (\`rethrow(e)\`).
        const stops = !handler.getBlock().getFirstDescendant((n) => {
          if (insideFunction(n, handler)) return false
          if (Node.isThrowStatement(n)) return true
          const callee = Node.isCallExpression(n) ? resolveCallee(n) : undefined
          return !!callee && this.isRepoPath(callee.getSourceFile().getFilePath()) && !!callee.getBody() && this.canThrow(callee)
        })
        visit(node.getTryBlock(), caught || stops)
        visit(handler, caught)
        const fin = node.getFinallyBlock()
        if (fin) visit(fin, caught)
        return
      }
      if (!caught) {
        if (unseenNew(node) || Node.isAwaitExpression(node)) found = node
        else if (Node.isCallExpression(node) && !/^console\./.test(node.getExpression().getText())) {
          const callee = resolveCallee(node)
          if (!callee || !this.isRepoPath(callee.getSourceFile().getFilePath()) || !callee.getBody()) found = node
          else if (this.throwsUnseen(callee, active, depth + 1)) found = node
        }
      }
      if (!found) node.forEachChild((c) => visit(c, caught))
    }
    visit(root, false)
    return found
  }

  /** True when a repo function can throw: a \`throw\` of its own, or any call it makes to one that can. */
  private canThrow(fn: FunctionLike): boolean {
    return this.throwsFrom(fn, new Set(), 0).found
  }

  /**
   * Whether \`fn\` can throw, and whether that answer is sure. It isn't when it
   * depended on a function still being worked out (recursion) or on the depth
   * cut-off; only sure answers are kept, so a cut-off never sticks as "can't throw".
   */
  private throwsFrom(fn: FunctionLike, active: Set<FunctionLike>, depth: number): { found: boolean; sure: boolean } {
    const known = this.throwers.get(fn)
    if (known !== undefined) return { found: known, sure: true }
    if (active.has(fn) || depth > 12) return { found: false, sure: false }
    active.add(fn)
    let found = false
    let sure = true
    const visit = (node: Node, caught: boolean) => {
      if (found || (node !== fn && isFunctionLike(node))) return
      if (Node.isTryStatement(node) && node.getCatchClause() && !isRethrow(node.getCatchClause()!)) {
        visit(node.getTryBlock(), true)
        visit(node.getCatchClause()!, caught)
        const fin = node.getFinallyBlock()
        if (fin) visit(fin, caught)
        return
      }
      if (!caught && Node.isThrowStatement(node)) found = true
      else if (!caught && Node.isCallExpression(node)) {
        const callee = resolveCallee(node)
        if (callee && callee !== fn && this.isRepoPath(callee.getSourceFile().getFilePath())) {
          const r = this.throwsFrom(callee, active, depth + 1)
          if (r.found) found = true
          else if (!r.sure) sure = false
        }
      }
      if (!found) node.forEachChild((c) => visit(c, caught))
    }
    const body = fn.getBody()
    if (body) visit(body, false)
    active.delete(fn)
    if (found || sure) this.throwers.set(fn, found)
    return { found, sure: found || sure }
  }

  private walkSwitch(stmt: SwitchStatement, ctx: Ctx, env: Env, next: Cont): string {
    const clauses = stmt.getClauses()
    const inner: Ctx = { ...ctx, breakTarget: next }
    // Each clause falls through to the next one unless it breaks or returns.
    const entries: Cont[] = []
    for (let i = clauses.length - 1; i >= 0; i--) {
      const clause = clauses[i]!
      const fallthrough = i + 1 < clauses.length ? entries[i + 1]! : next
      entries[i] = this.memo(ctx, clause, (e) => this.walkStatements(clause.getStatements(), inner, e, fallthrough), 'clause')
    }

    const fallback = clauses.findIndex((c) => Node.isDefaultClause(c))
    // `switch (true)` is an if/else chain over its cases, in order.
    if (unwrap(stmt.getExpression()).getKind() === SyntaxKind.TrueKeyword) {
      let chain = fallback >= 0 ? entries[fallback]!(env) : next(env)
      for (let i = clauses.length - 1; i >= 0; i--) {
        const clause = clauses[i]!
        if (Node.isCaseClause(clause)) chain = this.branchOn(clause.getExpression(), entries[i]!(env), chain, ctx, env)
      }
      return chain
    }
    // A discriminant whose value is known picks its case directly, when every case's value is known too.
    const known = this.knownValue(stmt.getExpression(), ctx, env)
    const caseValues = clauses.map((c) => (Node.isCaseClause(c) ? this.knownValue(c.getExpression(), ctx, env) : undefined))
    if (known !== undefined && clauses.every((c, i) => !Node.isCaseClause(c) || caseValues[i] !== undefined)) {
      const match = caseValues.findIndex((v) => v !== undefined && v === known)
      const pick = match >= 0 ? match : fallback
      return pick >= 0 ? entries[pick]!(env) : next(env)
    }

    const out: { label: string; to: string; value?: string }[] = clauses.map((clause, i) => {
      if (!Node.isCaseClause(clause)) return { label: 'default', to: entries[i]!(env) }
      const label = this.text(clause.getExpression(), ctx.frame, env)
      // A case written as a name (`Status.Active`) records the value it stands for, so verify can match it.
      const value = constantValue(clause.getExpression())
      return { label, to: entries[i]!(env), ...(value !== undefined && value !== normalizeCode(label) ? { value } : {}) }
    })
    const hasDefault = clauses.some((c) => Node.isDefaultClause(c))
    if (!hasDefault && !isExhaustive(stmt)) out.push({ label: 'other', to: next(env) })
    return this.decision(stmt.getExpression(), ctx, env, out, 'switch')
  }

  // ---- variables --------------------------------------------------------

  /** Records `const` / `let` / `var` declarations, including destructuring. */
  private declare(stmt: import('ts-morph').VariableStatement, ctx: Ctx, env: Env): Env {
    let out = env
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer()
      if (init && isFunctionLike(init)) continue
      const nameNode = decl.getNameNode()
      if (Node.isIdentifier(nameNode)) {
        let value = init ? this.valueFor(nameNode.getText(), init, ctx, env, `${decl.getStart()}`) : { text: 'undefined', simple: true }
        // \`const before = order.total\`, then the order changes, then \`order.total - before\`:
        // spelled out, \`before\` would read as the new total. It keeps its name instead.
        if (init && value !== 'unknown' && !value.byName && this.changedBeforeRead(decl, init, ctx.frame.fn)) {
          value = { text: nameNode.getText(), simple: true, byName: `${decl.getStart()}:${shortHash(value.text)}`, literal: oneLine(value.text), ...(value.deps ? { deps: value.deps } : {}) }
        }
        out = set(out, decl, value)
        continue
      }
      if (!init) continue
      // Destructuring a variable keeps what's known about it (its key, its changes).
      const initDecl = Node.isIdentifier(unwrap(init)) ? declOf(unwrap(init)) : undefined
      const tracked = initDecl ? env.get(initDecl) : undefined
      const base: Value = tracked ?? this.value(init, ctx, env)
      const prefix = base === 'unknown' ? undefined : base.simple ? base.text : `(${base.text})`
      /** A destructured property carries what the object it came from had: its key, any change to that property, and what it depends on. */
      const initDeps = this.identityOf(init, ctx.frame, env)
      const from = (prop: string): Partial<Exclude<Value, 'unknown'>> => {
        if (base === 'unknown') return initDeps ? { deps: initDeps } : {}
        const changed = Object.entries(base.versions ?? {}).find(([p]) => overlaps(prop, p))?.[1]
        return { ...(base.byName ? { byName: `${base.byName}.${prop}` } : {}), ...(changed ? { versions: { '*': changed } } : {}), ...(initDeps ? { deps: initDeps } : {}) }
      }
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const name = el.getNameNode()
          if (!Node.isIdentifier(name) || el.getDotDotDotToken() || el.getInitializer()) {
            if (Node.isIdentifier(name)) out = set(out, el, 'unknown')
            continue
          }
          const prop = el.getPropertyNameNode()?.getText() ?? name.getText()
          out = set(out, el, prefix ? { text: `${prefix}.${prop}`, simple: true, ...from(prop) } : 'unknown')
        }
      } else if (Node.isArrayBindingPattern(nameNode)) {
        nameNode.getElements().forEach((el, index) => {
          if (!Node.isBindingElement(el)) return
          const name = el.getNameNode()
          if (!Node.isIdentifier(name)) return
          out = set(out, el, prefix && !el.getDotDotDotToken() && !el.getInitializer() ? { text: `${prefix}[${index}]`, simple: true, ...from(String(index)) } : 'unknown')
        })
      }
    }
    return out
  }

  /**
   * Applies `x = value` to tracked variables and parameters. Other changes
   * (`x += 1`, `x++`) make them unknown. Changing an object through it
   * (`x.done = true`, `x.push(...)`) gives it a new version, so checks before
   * and after the change aren't treated as the same question.
   */
  private assign(expr: Expression, ctx: Ctx, env: Env): Env {
    const e = unwrap(expr)
    if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const target = localDeclaration(e.getLeft(), ctx.frame.fn)
      if (target) {
        // A reassigned parameter is shown by name unless its new value is a plain constant: the name reads better than the expression.
        const byNameIfComplex = Node.isParameterDeclaration(target)
        return set(env, target, this.valueFor(declarationName(target), e.getRight(), ctx, env, `${e.getStart()}`, byNameIfComplex))
      }
    }
    let out = env
    for (const decl of assignedIn(expr, ctx.frame.fn)) out = set(out, decl, 'unknown')
    for (const [decl, props] of mutatedIn(expr, ctx.frame.fn, true)) out = this.changed(out, decl, props, `${expr.getStart()}`, ctx.frame)
    return out
  }

  /** Records that these properties of `decl`'s object changed at `at`, so later checks of them are new questions. */
  private changed(env: Env, decl: Node, props: Iterable<string>, at: string, frame: Frame): Env {
    const before = env.get(decl)
    const arg = Node.isParameterDeclaration(decl) ? frame.params.get(decl) : undefined
    const versions = { ...(before && before !== 'unknown' ? before.versions : {}) }
    for (const p of props) versions[p] = at
    // The variable still holds the same object, so it keeps how it's shown, but its contents can't be read off any more.
    let shown: Exclude<Value, 'unknown'>
    if (before && before !== 'unknown') {
      const { before: _base, versions: _versions, props: _props, ...rest } = before
      shown = rest
    } else shown = { text: arg?.text ?? declarationName(decl), simple: arg?.simple ?? true, ...(arg?.key ? { argKey: arg.key } : {}) }
    // What it was before any change, to go back to once the changes stop mattering.
    const base: Value | 'absent' = before === undefined ? 'absent' : before === 'unknown' ? 'unknown' : (before.before ?? before)
    return set(env, decl, { ...shown, versions, before: base })
  }

  private value(expr: Expression, ctx: Ctx, env: Env): Value {
    const text = this.text(expr, ctx.frame, env)
    // \`await f()\` keeps its \`await\`, so \`(await f()).user\` needs the parentheses.
    let bare: Node = expr
    while (Node.isParenthesizedExpression(bare) || Node.isNonNullExpression(bare)) bare = bare.getExpression()
    // \`x as T\` keeps its \`as\` too, so \`(x as T).y\` needs them as well.
    return { text, simple: isSimple(unwrap(expr)) && !/^await\b/.test(text) && !Node.isAsExpression(bare) && !Node.isSatisfiesExpression(bare) }
  }

  /**
   * What a variable holds after `name = expr`. Objects, arrays and long
   * expressions are shown by name, with a key that tells different values
   * apart; with `byNameIfComplex`, so is anything that isn't a constant.
   */
  private valueFor(name: string, expr: Expression, ctx: Ctx, env: Env, at: string, byNameIfComplex = false): Value {
    const e = unwrap(expr)
    const constant = constantValue(e)
    if (isObjectLike(e)) {
      const literal = this.text(e, ctx.frame, env)
      const props = Node.isObjectLiteralExpression(e) ? this.literalProps(e, ctx, env) : undefined
      return { text: name, simple: true, byName: `${at}:${shortHash(literal)}`, literal: oneLine(literal), ...(props ? { props } : {}) }
    }
    const plain0 = this.value(expr, ctx, env)
    if (plain0 === 'unknown') return plain0
    const deps = this.identityOf(e, ctx.frame, env)
    const value = deps ? { ...plain0, deps } : plain0
    const plain = foldConstant(value.text).ok || constant !== undefined
    if (!plain && (value.text.length > MAX_SHOWN_VALUE || (byNameIfComplex && !Node.isIdentifier(e)))) {
      return { text: name, simple: true, byName: shortHash(value.text), literal: oneLine(value.text), ...(deps ? { deps } : {}) }
    }
    return constant !== undefined && !foldConstant(value.text).ok ? { ...value, constant } : value
  }

  /** The properties of `{ a: x, b }`, when every one is a plain named property (no spreads or methods). */
  private literalProps(e: import('ts-morph').ObjectLiteralExpression, ctx: Ctx, env: Env): Record<string, { text: string; simple: boolean }> | undefined {
    const out: Record<string, { text: string; simple: boolean }> = {}
    for (const p of e.getProperties()) {
      if (Node.isShorthandPropertyAssignment(p)) {
        const value = this.substitute(p.getNameNode(), ctx.frame, env, 0)
        out[p.getName()] = { text: value ?? p.getName(), simple: true }
      }
      else if (Node.isPropertyAssignment(p) && (Node.isIdentifier(p.getNameNode()) || Node.isStringLiteral(p.getNameNode()))) {
        const init = p.getInitializerOrThrow()
        out[Node.isStringLiteral(p.getNameNode()) ? (p.getNameNode() as import('ts-morph').StringLiteral).getLiteralValue() : p.getName()] = { text: this.text(init, ctx.frame, env), simple: isSimple(unwrap(init)) }
      } else return undefined
    }
    return out
  }

  /** The value an expression is known to have here, as JSON, or undefined. */
  private knownValue(expr: Expression, ctx: Ctx, env: Env): string | undefined {
    const folded = foldConstant(this.text(expr, ctx.frame, env))
    if (folded.ok) return JSON.stringify(folded.value)
    const e = unwrap(expr)
    if (Node.isIdentifier(e)) {
      const decl = declOf(e)
      const v = decl ? env.get(decl) : undefined
      if (v && v !== 'unknown') return v.constant
      // A module constant or enum member, as the type checker sees it.
      return decl && !isWithin(decl, ctx.frame.fn) && !Node.isParameterDeclaration(decl) ? constantValue(e) : undefined
    }
    return Node.isPropertyAccessExpression(e) ? constantValue(e) : undefined
  }

  /**
   * Memoizes a continuation by the values of variables that are still used
   * later, so branches that leave things the same share what comes next.
   */
  private memo(ctx: Ctx, at: Node, cont: Cont, tag = ''): Cont {
    const lastUse = this.lastUse(ctx.frame.fn)
    const propUse = this.propUse(ctx.frame.fn)
    const joinKey = `${ctx.frame.prefix}|${at.getSourceFile().getFilePath()}:${at.getStart()}|${tag}`
    // The same statement in the same inline context, with the same exits, continues
    // the same way whenever the variables match, even when reached by different walks.
    const exitKey = ctx.exit.kind === 'branch' ? `${ctx.exit.yes}|${ctx.exit.no}` : 'value'
    const cacheKey = `${joinKey}#${exitKey}#${ctx.frame.argsKey}#${ctx.catchKey ?? ''}`
    const cache = this.memoCache.get(cacheKey) ?? new Map<string, string>()
    this.memoCache.set(cacheKey, cache)
    const widenHere = this.widenAt.get(joinKey)
    const inner: Cont = (env) => {
      let live = env
      let key = envKey(live)
      // A result from an inlining that was later undone points at deleted boxes.
      const hit = cache.get(key)
      if (hit !== undefined && this.nodes.has(hit)) return hit
      let shown: [Node, Exclude<Value, 'unknown'>][] = []
      if (cache.size >= MAX_ENVS_PER_STATEMENT) {
        // Too many combinations: stop tracking values here. Branches that set
        // different values now continue the same way, so a step box shows what
        // each one set. Without it, both sides of a check would look the same
        // and the check would be dropped.
        const wide = new Map([...live].map(([k]) => [k, this.widened(k, ctx.frame, `wide:${at.getStart()}`)]))
        shown = [...live].filter(([d, v]) => v !== 'unknown' && valueKey(v) !== valueKey(wide.get(d)) && worthShowing(d, v)) as [Node, Exclude<Value, 'unknown'>][]
        live = wide
        key = envKey(live)
        const again = cache.get(key)
        if (again !== undefined && this.nodes.has(again)) return shown.length ? this.action(ctx, at, shown, again) : again
        this.warn(`Too many combinations of variable values in ${ctx.frame.name} (line ${at.getStartLineNumber()}${tag ? `, ${tag}` : ''}); some are shown as unknown.`)
      }
      const before = this.decisionCount
      const result = cont(live)
      cache.set(key, result)
      const join = this.joins.get(joinKey) ?? { order: this.joins.size, sizes: [], envs: [] }
      join.sizes.push(this.decisionCount - before)
      join.envs.push(live)
      this.joins.set(joinKey, join)
      return shown.length ? this.action(ctx, at, shown, result) : result
    }
    const settle = (env: Env, rest: (live: Env) => string): string => {
      const { live, dropped } = this.settleWidened(env, ctx, at)
      const target = rest(live)
      return dropped.length ? this.action(ctx, at, dropped, target) : target
    }
    return (env) => settle(prune(env, lastUse, propUse, at.getStart()), (live) => {
      if (widenHere) {
        // Draw what follows once: forget the values that differ between branches,
        // and show what this branch set in a step box on the way in.
        const widen = [...live].filter(([d, v]) => widenHere.has(d.getStart()) && v !== 'unknown') as [Node, Exclude<Value, 'unknown'>][]
        // Parameters that differ between copies may be missing from this one; they're forgotten too.
        const params = ctx.frame.fn.getParameters().filter((p) => widenHere.has(p.getStart()) && !live.has(p))
        if (widen.length || params.length) {
          const forgotten = new Map(live)
          for (const d of [...widen.map(([d]) => d), ...params]) forgotten.set(d, this.widened(d, ctx.frame, `join:${at.getStart()}`))
          this.warn(`Checks after line ${at.getStartLineNumber()} in ${ctx.frame.name} are drawn once for every branch; step boxes show what each branch set.`)
          const shown = widen.filter(([d, v]) => worthShowing(d, v))
          const target = inner(forgotten)
          return shown.length ? this.action(ctx, at, shown, target) : target
        }
      }
      return inner(live)
    })
  }

  /**
   * Drops changes no box will tell apart, and shows them here instead. A change
   * whose later reads all come after a join that forgets the variable makes no
   * difference to any box: after the join every path asks the same question. Left
   * in, it splits what follows into one copy per branch that made it, each behind
   * its own step box listing every change so far. Dropped here, with a step box
   * for just this change, the copies meet again at the next statement.
   */
  private settleWidened(env: Env, ctx: Ctx, at: Node): { live: Env; dropped: [Node, Exclude<Value, 'unknown'>][] } {
    const none = { live: env, dropped: [] }
    // A read earlier in a loop body runs again after the change, on the next pass.
    if (ctx.loop || !this.widenAt.size) return none
    const position = at.getStart()
    const points = this.widenPoints(ctx.frame.prefix, at.getSourceFile().getFilePath())
    if (!points.size) return none
    const reads = this.allReads(ctx.frame.fn)
    let out: Map<Node, Value> | undefined
    const dropped: [Node, Exclude<Value, 'unknown'>][] = []
    for (const [decl, value] of env) {
      if (value === 'unknown' || !value.versions) continue
      const join = Math.min(...(points.get(decl.getStart()) ?? []).filter((p) => p > position))
      if (!Number.isFinite(join)) continue
      const seen = (reads.get(decl) ?? []).filter(([, pos]) => pos >= position && pos < join)
      const versions = Object.fromEntries(Object.entries(value.versions).filter(([p]) => seen.some(([r]) => overlaps(r, p))))
      if (Object.keys(versions).length === Object.keys(value.versions).length) continue
      // Only changes made here are shown; ones a join already forgot were shown there.
      if (Object.entries(value.versions).some(([p, v]) => !(p in versions) && /^\d+$/.test(v))) dropped.push([decl, value])
      // With nothing left to tell paths apart, every path holds the same thing here, whatever it changed on the way.
      const { versions: _v, before: _b, ...plain } = value
      out ??= new Map(env)
      if (Object.keys(versions).length) out.set(decl, { ...value, versions })
      // \`this\`, or a parameter still holding its argument, is the same as never tracked.
      else if (value.before === 'absent' || isFunctionLike(decl) || (Node.isParameterDeclaration(decl) && !plain.byName && plain.text === (ctx.frame.params.get(decl)?.text ?? declarationName(decl)))) out.delete(decl)
      // A value a join would show (\`errors = []\`) mustn't look like it never changed. It keeps
      // what it holds, so paths that built it differently stay apart, and one mark for
      // the coming join, so paths that only changed it in different places meet again.
      else if (plain.byName || plain.text !== declarationName(decl)) out.set(decl, { ...plain, versions: { '*': `settled:${join}` } })
      else out.set(decl, plain)
    }
    return out ? { live: out, dropped } : none
  }

  /** Where joins widen each variable in this inline context and file, by the variable's position. Joins after a loop are left out: they sit at the loop's end, not its start. */
  private widenPoints(prefix: string, file: string): Map<number, number[]> {
    const key = `${prefix}|${file}`
    let points = this.widenPointCache.get(key)
    if (points) return points
    points = new Map()
    for (const [join, vars] of this.widenAt) {
      const [p, place, tag] = join.split('|')
      if (p !== prefix || tag === 'after' || !place?.startsWith(`${file}:`)) continue
      const pos = Number(place.slice(file.length + 1))
      for (const v of vars) points.set(v, [...(points.get(v) ?? []), pos])
    }
    this.widenPointCache.set(key, points)
    return points
  }

  /** Every read of each local, \`this\` and parameter in \`fn\`, with the path read (\`*\` for any whole use, such as passing it on). */
  private allReads(fn: FunctionLike): Map<Node, [string, number][]> {
    let reads = this.readCache.get(fn)
    if (reads) return reads
    reads = new Map()
    fn.getBody()?.forEachDescendant((node) => {
      if ((!Node.isIdentifier(node) && !thisKey(node, fn)) || isWriteTarget(node)) return
      const decl = thisKey(node, fn) ?? declOf(node)
      if (!decl || !isWithin(decl, fn) || (decl as Node & { getNameNode?(): Node }).getNameNode?.() === node) return
      reads!.set(decl, [...(reads!.get(decl) ?? []), [propertyRead(node) ? accessPath(node) : '*', node.getStart()]])
    })
    this.readCache.set(fn, reads)
    return reads
  }

  /**
   * What a variable is once Vantle stops telling its values apart at `tag`. It
   * depends only on the variable, so every copy that reaches the join forgets it
   * the same way. An object (a parameter, or a variable that starts as an object)
   * keeps its name and one "changed before here" mark, so later checks aren't
   * merged with earlier ones; anything else becomes unknown.
   */
  private widened(decl: Node, frame: Frame, tag: string): Value {
    if (Node.isParameterDeclaration(decl)) {
      // A parameter this function reassigns no longer holds the caller's argument.
      if (assignedIn(frame.fn.getBody() ?? frame.fn, frame.fn).has(decl)) return { text: declarationName(decl), simple: true, byName: tag }
      const arg = frame.params.get(decl)
      return { text: arg?.text ?? declarationName(decl), simple: arg?.simple ?? true, versions: { '*': tag }, ...(arg?.key ? { argKey: arg.key } : {}) }
    }
    if (isFunctionLike(decl)) return { text: 'this', simple: true, versions: { '*': tag } }
    const init = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined
    if (init && isObjectLike(init)) return { text: declarationName(decl), simple: true, versions: { '*': tag } }
    return 'unknown'
  }

  /** A step box: what one branch set before control reaches a shared part of the chart. */
  private action(ctx: Ctx, at: Node, known: [Node, Exclude<Value, 'unknown'>][], target: string): string {
    const file = at.getSourceFile()
    const lines = (v: Exclude<Value, 'unknown'>) =>
      [...new Set(Object.values(v.versions ?? {}).filter((p) => /^\d+$/.test(p)).map((p) => file.getLineAndColumnAtPos(Number(p)).line))].sort((a, b) => a - b)
    const parts = known.map(([d, v]) => {
      const variable = declarationName(d)
      if (v.versions) {
        const at = lines(v)
        return { variable, value: '<changed>', label: `${variable} changed${at.length ? ` (line ${at.join(', ')})` : ''}` }
      }
      const value = v.byName ? (v.literal ?? v.text) : v.text
      return { variable, value, label: `${variable} = ${value}` }
    })
    // What a step set is a fact for later checks only in the entry function. A step inside a
    // helper sets the helper's own local, which can share its name with the caller's variable
    // (or with the caller's value the helper is shown with), so it gives none. Inside a \`try\` or
    // catch that unseen code can throw out of or into, what a step set isn't known on every
    // route the code takes: the step forgets the variable instead.
    const assigns = ctx.frame.prefix ? [] : parts.map(({ variable, value }) => ({ variable, value: ctx.untrusted ? '<changed>' : value }))
    const rawLabel = parts.map((p) => p.label).join('; ')
    const id = `${this.flowId}:${ctx.frame.prefix}${structuralPath(at, ctx.frame.fn)}:set:${shortHash(`${rawLabel}>${target}`)}`
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind: 'action', rawLabel, assigns, source: this.sourceRef(at, ctx.frame) })
      this.edges.push({ from: id, to: target, label: 'next' })
    }
    return id
  }

  /**
   * True when something \`init\` reads (\`order\` in \`const before = order.total\`)
   * can change after \`decl\` and before a later read of \`decl\`, so spelling
   * \`decl\` out as \`init\` there would read as the changed value.
   */
  private changedBeforeRead(decl: Node, init: Node, fn: FunctionLike): boolean {
    const sources = new Set<Node>()
    const visit = (n: Node) => {
      if (isFunctionLike(n)) return
      const self = thisKey(n, fn)
      if (self) sources.add(self)
      else if (Node.isIdentifier(n)) {
        const d = declOf(n)
        if (d && isWithin(d, fn)) sources.add(d)
      }
      n.forEachChild(visit)
    }
    visit(init)
    if (!sources.size) return false
    const lastRead = Math.max(-1, ...(this.allReads(fn).get(decl) ?? []).map(([, pos]) => pos))
    // Any change, including a call Vantle can't see into that's given the object: a
    // name is never wrong, and a spelled-out value can be.
    return this.changeSites(fn).some((c) => sources.has(c.decl) && c.at > decl.getEnd() && c.at < lastRead)
  }

  /** For each local variable and parameter of `fn`, the last position each property is read (`x.a`), or the whole object (`*`). */
  private propUse(fn: FunctionLike): Map<Node, Map<string, number>> {
    let uses = this.propUses.get(fn)
    if (uses) return uses
    uses = new Map()
    fn.getBody()?.forEachDescendant((node) => {
      if ((!Node.isIdentifier(node) && !thisKey(node, fn)) || isWriteTarget(node)) return
      const decl = thisKey(node, fn) ?? declOf(node)
      if (!decl || !isWithin(decl, fn) || (decl as Node & { getNameNode?(): Node }).getNameNode?.() === node) return
      // Passing the whole object to a call that is a check (`if (isValid(order))`)
      // could read any property (`*`). Passing it to a returned helper call
      // (`return isAdmin(user)`) reads what that helper reads of it. Other whole
      // uses (logging it, building a result from it) don't change any box.
      const reads = propertyRead(node) ? [accessPath(node)] : this.wholeUseReads(node)
      const props = uses!.get(decl) ?? new Map<string, number>()
      for (const prop of reads) props.set(prop, Math.max(props.get(prop) ?? -1, node.getStart()))
      if (reads.length) uses!.set(decl, props)
    })
    this.propUses.set(fn, uses)
    return uses
  }

  /** The properties a whole-object use can read, as described in `propUse`. */
  private wholeUseReads(id: Node): string[] {
    const parent = id.getParent()
    // `return res` hands back the object itself, so the outcome shows any change to it.
    if (Node.isReturnStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === id)) return ['*']
    // `const { a, b } = x` reads `a` and `b`.
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === id) {
      const pattern = parent.getNameNode()
      if (Node.isObjectBindingPattern(pattern)) return pattern.getElements().map((el) => el.getPropertyNameNode()?.getText() ?? el.getName())
      if (Node.isArrayBindingPattern(pattern)) return ['*']
    }
    // Drawing follows the reads Vantle recognises: passing it to a call that is a
    // check, or to a returned helper, which reads what that helper reads of it.
    // A change only some other use could see isn't drawn; the box after it still
    // counts as a new question (see `changeSites`), so no path is ruled out wrongly.
    const use = wholeUse(id)
    if (!use) return []
    if (use.kind === 'check') return ['*']
    const fn = resolveCallee(use.call)
    const param = fn && this.isRepoPath(fn.getSourceFile().getFilePath()) && use.index !== undefined ? fn.getParameters()[use.index] : undefined
    return param ? paramReads(fn!, param) : []
  }

  /**
   * Every place in `fn` that changes an object, with the variable and the path
   * changed (`user.log` for `x.user.log.push(...)`, `*` for the whole object).
   * A check that reads what changed earlier in the function is a different
   * question from the same check before it, on every path. This doesn't depend
   * on how values were tracked, so it never rules out a path that can happen.
   */
  private changeSites(fn: FunctionLike): { decl: Node; path: string; at: number }[] {
    let sites = this.changeCache.get(fn)
    if (sites) return sites
    sites = []
    const visit = (n: Node) => {
      if (n !== fn && isFunctionLike(n)) return
      if (Node.isExpressionStatement(n) || Node.isVariableStatement(n) || Node.isReturnStatement(n) || Node.isIfStatement(n)) {
        const target = Node.isExpressionStatement(n) ? n.getExpression() : Node.isIfStatement(n) ? n.getExpression() : n
        for (const [decl, paths] of mutatedIn(target, fn, Node.isExpressionStatement(n), true)) for (const path of paths) sites!.push({ decl, path, at: n.getStart() })
      }
      n.forEachChild(visit)
    }
    fn.getBody()?.forEachChild(visit)
    this.changeCache.set(fn, sites)
    return sites
  }

  /** For each local variable of `fn`, the position of its last use. */
  private lastUse(fn: FunctionLike): Map<Node, number> {
    let uses = this.lastUses.get(fn)
    if (uses) return uses
    uses = new Map()
    fn.getBody()?.forEachDescendant((node) => {
      const self = thisKey(node, fn)
      if (self) uses!.set(self, Math.max(uses!.get(self) ?? -1, node.getStart()))
      if (!Node.isIdentifier(node)) return
      const decl = declOf(node)
      if (!decl || (!Node.isVariableDeclaration(decl) && !Node.isBindingElement(decl) && !Node.isParameterDeclaration(decl)) || !isWithin(decl, fn)) return
      if (decl.getNameNode() === node) return
      uses!.set(decl, Math.max(uses!.get(decl) ?? -1, node.getStart()))
    })
    this.lastUses.set(fn, uses)
    return uses
  }

  // ---- expressions ------------------------------------------------------

  private returnValue(expr: Expression | undefined, ctx: Ctx, env: Env, at: Node): string {
    if (!expr) return ctx.exit.kind === 'branch' ? ctx.exit.no : this.outcome('undefined', at, ctx.frame)
    if (ctx.exit.kind === 'branch') return this.branchOn(expr, ctx.exit.yes, ctx.exit.no, ctx, env)

    const e = unwrap(expr)
    if (Node.isConditionalExpression(e)) {
      return this.branchOn(
        e.getCondition(),
        this.returnValue(e.getWhenTrue(), ctx, env, at),
        this.returnValue(e.getWhenFalse(), ctx, env, at),
        ctx,
        env,
      )
    }
    if (Node.isCallExpression(e)) {
      const inlined = this.tryInline(e, ctx, env, { kind: 'value' })
      if (inlined) return inlined
      // Not drawn as a value (too big, say): its throws still come before the result, drawn or listed.
      const result = this.returnedValue(e, ctx, env, at)
      return this.throwingOne(e, ctx, env, () => result) ?? result
    }
    return this.returnedValue(e, ctx, env, at)
  }

  private returnedValue(e: Expression, ctx: Ctx, env: Env, at: Node): string {
    // Like conditions, a returned `await x()` is probed after it resolves.
    let value = this.text(e, ctx.frame, env)
    // Returning an object changed on the way (`res.body = 'ok'; return res`) is a
    // different outcome from returning it unchanged, or changed somewhere else.
    if (Node.isIdentifier(e) || thisKey(e, ctx.frame.fn)) {
      const decl = thisKey(e, ctx.frame.fn) ?? declOf(e)
      const v = decl ? env.get(decl) : undefined
      if (v && v !== 'unknown' && v.versions) {
        const lines = [...new Set(Object.values(v.versions).filter((p) => /^\d+$/.test(p)).map((p) => e.getSourceFile().getLineAndColumnAtPos(Number(p)).line))].sort((a, b) => a - b)
        value = `${value} (changed${lines.length ? ` at line ${lines.join(', ')}` : ''})`
      }
    }
    // A helper returning one of its own variables (`return ret`) is named by the call,
    // so different calls stay different outcomes.
    if (ctx.frame.callText && this.showsLocalNames(e, ctx.frame, env)) value = `${ctx.frame.callText} → ${value}`
    return this.outcome(value, at, ctx.frame, awaited(e), this.valueIdentity(e, ctx.frame, env))
  }

  /**
   * What makes this returned value differ from the same code returned on another
   * path: a local computed differently (\`isShared\` in the Viewer case and in the
   * Editor case), or something the path changed before it (\`opts.flags\` set on one
   * branch, then \`return await super.update(opts)\`). Only parts that differ between
   * paths count, so the same return reached the same way stays one outcome.
   */
  private valueIdentity(expr: Node, frame: Frame, env: Env): string | undefined {
    const parts = (this.identityOf(expr, frame, env) ?? '').split(',').filter((p) => p && !p.startsWith('after ') && !p.startsWith('in '))
    if (!parts.length) return undefined
    // Positions become places in the function's structure, so the id holds when unrelated code moves.
    const file = frame.fn.getSourceFile()
    const place = (pos: string) => {
      const at = file.getDescendantAtPos(Number(pos))
      const stmt = at?.getParentWhile((p) => !Node.isStatement(p)) ?? at
      return stmt && isWithin(stmt, frame.fn) ? structuralPath(stmt, frame.fn) : pos
    }
    return parts.map((p) => p.replace(/=\d+:/, '=').replace(/@(\d+)$/, (_, pos: string) => `@${place(pos)}`)).join(',')
  }

  /** Returns the node that decides between `yes` and `no` based on `expr`. */
  private branchOn(expr: Expression, yes: string, no: string, ctx: Ctx, env: Env): string {
    if (yes === no) return yes
    const e = unwrap(expr)
    if (Node.isPrefixUnaryExpression(e) && e.getOperatorToken() === SyntaxKind.ExclamationToken) {
      return this.branchOn(e.getOperand(), no, yes, ctx, env)
    }
    if (e.getKind() === SyntaxKind.TrueKeyword) return yes
    if (e.getKind() === SyntaxKind.FalseKeyword) return no
    // A condition that the variables' known values decide, like `!found` after `let found = false`.
    const known = foldConstant(this.text(e, ctx.frame, env))
    if (known.ok) return known.value ? yes : no
    if (Node.isConditionalExpression(e)) {
      return this.branchOn(
        e.getCondition(),
        this.branchOn(e.getWhenTrue(), yes, no, ctx, env),
        this.branchOn(e.getWhenFalse(), yes, no, ctx, env),
        ctx,
        env,
      )
    }
    const asked = () =>
      this.decision(e, ctx, env, [
        { label: 'yes', to: yes },
        { label: 'no', to: no },
      ], 'boolean')
    if (Node.isCallExpression(e)) {
      const inlined = this.tryInline(e, ctx, env, { kind: 'branch', yes, no })
      if (inlined) return inlined
      // Shown as one box: its throws come before the answer, drawn or listed.
      const box = asked()
      return this.throwingOne(e, ctx, env, () => box) ?? box
    }
    return asked()
  }

  /** Walks into the called function when that adds branches to the chart. */
  private tryInline(call: CallExpression, ctx: Ctx, env: Env, exit: Exit, maxAdded = this.options.maxInline ?? Infinity, forThrows = false): string | undefined {
    const fn = resolveCallee(call)
    // Drawn for its throws, a helper needs no checks of its own: \`return inner(x) * 2\` throws through inner.
    if (!fn || !this.isRepoPath(fn.getSourceFile().getFilePath()) || (!forThrows && !hasBranching(fn))) return undefined
    const name = functionName(fn)
    if (ctx.frame.stack.includes(fn)) {
      this.warn(`${name} calls itself (directly or indirectly); the recursive call is shown as one box.`)
      return undefined
    }
    // A recursive helper walks a data structure (a rules engine, a parser), so
    // its branches describe the data, not the decision. Keep it as one box.
    if (fn !== ctx.frame.stack[0] && isRecursive(fn, (p) => this.isRepoPath(p))) {
      this.warn(`${name} is recursive, so it's shown as one box.`)
      return undefined
    }
    if (ctx.frame.depth >= this.options.depth) {
      this.warn(`Stopped following calls at depth ${this.options.depth} (at ${name}). Raise --depth to go deeper.`)
      return undefined
    }

    const params = new Map<ParameterDeclaration, Arg>()
    const args = call.getArguments()
    fn.getParameters().forEach((param, i) => {
      const arg = args[i]
      if (!arg) {
        // A missing argument takes the parameter's default, which can use the earlier parameters.
        const init = param.getInitializer()
        const scope: Frame = { fn, name, params, prefix: ctx.frame.prefix, argsKey: '', stack: [], depth: ctx.frame.depth + 1, via: [], outer: [...(ctx.frame.outer ?? []), ...this.changes.before(ctx.frame.fn, call)] }
        // Built from earlier parameters (\`k = w.kind\`), it's told apart the way they are.
        const id = init && this.identityOf(init, scope, EMPTY_ENV)
        params.set(param, init ? this.shownArg(declarationName(param), this.text(init, scope), isSimple(init), id ? { key: shortHash(id) } : {}) : { text: 'undefined', simple: true })
        return
      }
      const text = this.text(arg, ctx.frame, env)
      params.set(param, this.shownArg(declarationName(param), text, simpleArg(arg, text, isSimple(arg)), this.argState(arg, ctx, env)))
    })
    // In `obj.method()`, `this` inside the method is `obj`.
    const callee = unwrap(call.getExpression())
    const receiver: Arg | undefined = Node.isPropertyAccessExpression(callee)
      ? this.shownArg('this', this.text(callee.getExpression(), ctx.frame, env), simpleArg(callee.getExpression(), this.text(callee.getExpression(), ctx.frame, env), isSimple(unwrap(callee.getExpression()))), this.argState(callee.getExpression(), ctx, env))
      : undefined
    const argKey = (a: Arg) =>
      `${a.text}${a.key ? `=${a.key}` : ''}${a.versions ? `{${Object.entries(a.versions).sort().map(([p, v]) => `${p}@${v}`).join(',')}}` : ''}${a.changes?.length ? `[${a.changes.map((c) => `${c.path}@${c.at}`).join(',')}]` : ''}`
    // Changes made before this call (in this caller, and in its callers before their calls) can
    // make the helper's checks new questions. Two calls share boxes only when nothing the helper
    // reads can change between them. Along a route the changes that can come before a call only
    // grow, so the number of them tells calls apart exactly when one happened in between (calls in
    // two \`case\`s, each after its own change, still share). A change in a callback kept to run
    // later can happen at any time, so it never lets two calls share.
    const here = this.changes.before(ctx.frame.fn, call)
    const outer = [...(ctx.frame.outer ?? []), ...here]
    const reads = this.changes.readsOf(fn)
    const relevant = here.filter((c) => this.changes.relevant(c, reads))
    const changedKey = relevant.some((c) => c.floating) ? `|~${call.getStart()}` : relevant.length ? `|${relevant.length}` : ''
    const argsKey = `${receiver ? `${argKey(receiver)}.` : ''}(${[...params.values()].map(argKey).join(', ')})${changedKey}`

    // The same call with the same arguments and destinations builds the same
    // subgraph, so reuse it. This keeps shared helpers as one set of boxes.
    // Inside a try, a throw takes the caller's variables into the catch, so they're part of what's built.
    const exitKey = `${exit.kind === 'branch' ? `${exit.yes}|${exit.no}` : 'value'}${ctx.catchKey ? `!${ctx.catchKey}:${envKey(env)}` : ''}`
    const key = `${fn.getSourceFile().getFilePath()}:${fn.getStart()}${argsKey}->${exitKey}`
    // This call, as a place in the caller, so verify can tell which run of the helper a box's answer came from.
    const last = args.at(-1)
    const lastExpr = last && Node.isSpreadElement(last) ? last.getExpression() : last
    const site: Span = {
      ...this.span(call, ctx.frame),
      callee: `${relPath(this.vp.root, fn.getSourceFile())}#${name}`,
      ...(lastExpr ? { lastArg: [lastExpr.getStart() - call.getStart(), lastExpr.getEnd() - call.getStart()] as [number, number] } : {}),
    }
    const via = [...ctx.frame.via, site]
    const existing = this.inlined.get(key)
    if (existing && this.nodes.has(existing)) {
      // The same boxes, reached through another call: they now also take answers from that call's run.
      const shared = this.inlinedVia.get(key)
      if (shared) {
        for (const id of shared.nodes) {
          const node = this.nodes.get(id)
          if (node?.kind !== 'decision' || !node.via) continue
          for (const alt of [...node.via]) {
            if (alt.length < shared.via.length || !shared.via.every((s, i) => sameSpan(s, alt[i]!))) continue
            const moved = [...via, ...alt.slice(shared.via.length)]
            if (!node.via.some((v) => v.length === moved.length && v.every((s, i) => sameSpan(s, moved[i]!)))) {
              node.via.push(moved)
              this.viaLog.push({ node: id, route: moved })
            }
          }
        }
      }
      return existing
    }

    this.files.add(fn.getSourceFile())
    const frame: Frame = {
      fn,
      name,
      params,
      prefix: `${ctx.frame.prefix}${structuralPath(call, ctx.frame.fn)}>${name}/`,
      argsKey: `${ctx.frame.argsKey}>${argsKey}`,
      receiver,
      callText: this.text(call, ctx.frame, env),
      stack: [...ctx.frame.stack, fn],
      depth: ctx.frame.depth + 1,
      via,
      outer,
    }
    this.maxDepth = Math.max(this.maxDepth, frame.depth)
    const before = {
      nodes: new Set(this.nodes.keys()),
      edges: this.edges.length,
      inlined: new Set(this.inlined.keys()),
      warnings: new Set(this.warnings),
      scope: new Set(this.scope.keys()),
      joins: new Set(this.joins.keys()),
      notCharted: new Set(this.notCharted.keys()),
      decisionCount: this.decisionCount,
      viaLog: this.viaLog.length,
      outcomeSpans: new Map([...this.nodes.values()].flatMap((n) => (n.kind === 'outcome' ? [[n.id, n.spans?.length ?? 0] as const] : []))),
    }
    if (!this.scope.has(fn)) this.scope.set(fn, { file: relPath(this.vp.root, fn.getSourceFile()), name })
    // A throw in the helper reaches the caller's catch with the caller's variables as they were at the call.
    const callerCatch = ctx.catchTarget
    const entry = this.walkBody(fn, {
      frame,
      exit,
      ...(callerCatch ? { catchTarget: () => callerCatch(env), catchKey: `${ctx.catchKey}@${envKey(env)}` } : {}),
      ...(ctx.untrusted ? { untrusted: ctx.untrusted } : {}),
    })
    const added = [...this.nodes.values()].filter((n) => n.kind === 'decision' && !before.nodes.has(n.id)).length
    const limit = maxAdded
    if (added > limit) {
      // Too big: undo this inlining and keep the call as one box.
      for (const id of [...this.nodes.keys()]) if (!before.nodes.has(id)) this.nodes.delete(id)
      this.edges.length = before.edges
      for (const k of [...this.inlined.keys()]) if (!before.inlined.has(k)) this.inlined.delete(k)
      for (const w of [...this.warnings]) if (!before.warnings.has(w)) this.warnings.delete(w)
      for (const f of [...this.scope.keys()]) if (!before.scope.has(f)) this.scope.delete(f)
      for (const k of [...this.joins.keys()]) if (!before.joins.has(k)) this.joins.delete(k)
      for (const k of [...this.notCharted.keys()]) if (!before.notCharted.has(k)) this.notCharted.delete(k)
      this.decisionCount = before.decisionCount
      // Routes this inlining added to boxes drawn earlier go too.
      for (const { node: id, route } of this.viaLog.splice(before.viaLog)) {
        const node = this.nodes.get(id)
        if (node?.kind === 'decision' && node.via) node.via = node.via.filter((r) => r !== route)
      }
      for (const [id, n] of before.outcomeSpans) {
        const node = this.nodes.get(id)
        if (node?.kind === 'outcome' && node.spans) node.spans = node.spans.slice(0, n)
      }
      if (limit === (this.options.maxInline ?? Infinity)) this.warn(`${name} is shown as one box: following it would add ${added} boxes (limit ${limit}). Raise --max-inline to see inside it.`)
      return undefined
    }
    this.inlined.set(key, entry)
    // Every box this call reaches before leaving the helper, including boxes of helpers inside it that
    // were drawn earlier, so reusing this call elsewhere adds the route to all of them.
    this.inlinedVia.set(key, { via, nodes: this.boxesUntil(entry, exit) })
    return entry
  }

  // ---- nodes ------------------------------------------------------------

  private decision(expr: Node, ctx: Ctx, env: Env, out: { label: string; to: string; value?: string }[], branch: 'boolean' | 'switch'): string {
    const frame = ctx.frame
    const rawLabel = this.text(expr, frame, env)
    const base = `${this.flowId}:${frame.prefix}${structuralPath(expr, frame.fn)}:${shortHash(rawLabel)}`
    const isVolatile = volatile(expr)
    // A check in a \`try\` that unseen code can throw out of answers a separate question from
    // the same check in its catch or after it: the catch can be reached from places the chart
    // doesn't draw, where this check went either way or never ran.
    const parts = [isVolatile ? undefined : this.identityOf(expr, frame, env), ctx.untrusted && !isVolatile ? `in ${ctx.untrusted}` : undefined].filter((p): p is string => !!p)
    const sharedIdentity = parts.length ? parts.join(',') : undefined
    // Two walks that reach the same check with values that differ in ways no box
    // shows build identical copies. The same box, asking the same question with
    // the same arrows, is one box, so those copies merge back.
    const shape = `${base}|${branch}|${ctx.loop ?? ''}|${sharedIdentity ?? ''}|${isVolatile}|${out.map((o) => `${o.label}>${o.to}`).join(',')}`
    const same = this.shapes.get(shape)
    if (same && this.nodes.has(same)) return same
    const id = this.uniqueId(base)
    this.shapes.set(shape, id)
    const calls = this.calls(expr)
    this.decisionCount++
    const identity = isVolatile ? id : sharedIdentity
    const callback = expr.getFirstDescendant((n) => isFunctionLike(n))
    if (callback) {
      this.note('callback', expr, frame, oneLine(expr.getText()), 'Checks inside the callback are shown as one box.')
    }
    this.nodes.set(id, {
      id,
      kind: 'decision',
      branch,
      ...(ctx.loop ? { loop: ctx.loop } : {}),
      rawLabel,
      categoryHint: categorize(rawLabel, calls),
      calls,
      source: this.sourceRef(expr, frame),
      spans: [this.span(awaited(expr), frame)],
      via: [frame.via],
      ...(identity ? { identity } : {}),
    })
    for (const o of out) this.edges.push({ from: id, to: o.to, label: o.label, ...(o.value !== undefined ? { value: o.value } : {}) })
    return id
  }

  /** What a variable passed to a helper carries in: its key when shown by name, and its changes. */
  /**
   * How a helper's parameter reads in its boxes: as the caller's argument, or by
   * its own name when the argument is long (\`users\` rather than three copies of
   * \`(false ? users : [(await Users.findOneById(...)), ...users])\` in one label).
   * Shown by name, the argument's text becomes its key, so different arguments
   * stay different questions.
   */
  private shownArg(name: string, text: string, simple: boolean, state: Pick<Arg, 'key' | 'versions' | 'changes'>): Arg {
    if (text.length <= MAX_SHOWN_VALUE || foldConstant(text).ok) return { text, simple, ...state }
    return { text: name, simple: true, ...state, key: state.key ? `${state.key}:${shortHash(text)}` : shortHash(text) }
  }

  private argState(arg: Node, ctx: Ctx, env: Env): Pick<Arg, 'key' | 'versions' | 'changes'> {
    const e = unwrapAny(arg)
    const self = thisKey(e, ctx.frame.fn)
    const root = self ?? (Node.isIdentifier(e) ? declOf(e) : undefined)
    const changes = root
      ? [
          ...this.changeSites(ctx.frame.fn).filter((c) => c.decl === root && c.at < arg.getStart()).map((c) => ({ path: c.path, at: c.at })),
          ...(Node.isParameterDeclaration(root) ? (ctx.frame.params.get(root)?.changes ?? []) : []),
          ...(self ? (ctx.frame.receiver?.changes ?? []) : []),
        ]
      : []
    const withChanges = changes.length ? { changes } : {}
    if (self) {
      const v = env.get(self)
      return { ...withChanges, ...(ctx.frame.receiver?.key ? { key: ctx.frame.receiver.key } : {}), ...(v && v !== 'unknown' && v.versions ? { versions: v.versions } : ctx.frame.receiver?.versions ? { versions: ctx.frame.receiver.versions } : {}) }
    }
    if (!Node.isIdentifier(e)) {
      // An expression (\`w.cfg\`, \`p.lookup(id)\`) is told apart by what its parts are.
      const id = this.identityOf(e, ctx.frame, env)
      return id ? { key: shortHash(id) } : {}
    }
    const decl = declOf(e)
    const v = decl ? env.get(decl) : undefined
    if (v && v !== 'unknown') return { ...withChanges, ...((v.byName ?? v.argKey) ? { key: (v.byName ?? v.argKey)! } : {}), ...(v.versions ? { versions: v.versions } : {}) }
    const param = decl && Node.isParameterDeclaration(decl) ? ctx.frame.params.get(decl) : undefined
    return { ...withChanges, ...(param?.key ? { key: param.key } : {}), ...(param?.versions ? { versions: param.versions } : {}) }
  }

  /**
   * What tells this box apart from another with the same code: the keys of
   * variables shown by name, changes to what it reads, and, for a helper's own
   * variables shown by name, which call of the helper this is.
   */
  private identityOf(expr: Node, frame: Frame, env: Env): string | undefined {
    const parts = new Set<string>()
    let local = false
    const visit = (n: Node, inner: Node[]) => {
      if (n !== expr && isFunctionLike(n)) {
        n.forEachChild((c) => visit(c, [...inner, n]))
        return
      }
      if (n.getKind() === SyntaxKind.ThisKeyword && !inner.some((f) => !Node.isArrowFunction(f))) {
        const v = env.get(frame.fn)
        const read = readPath(n)
        const versions = v && v !== 'unknown' ? v.versions : frame.receiver?.versions
        // A receiver shown as \`this\` (its call was long) is told apart by its key.
        if (frame.receiver?.key) parts.add(`this=${frame.receiver.key}`)
        for (const [p, at] of Object.entries(versions ?? {})) if (overlaps(read, p)) parts.add(`this.${p}@${at}`)
        for (const c of frame.receiver && !v ? (frame.receiver.changes ?? []) : []) if (overlaps(read, c.path)) parts.add(`after this.${c.path}@${c.at}`)
        for (const c of this.changeSites(frame.fn)) if (c.decl === frame.fn && c.at < expr.getStart() && overlaps(read, c.path)) parts.add(`after this.${c.path}@${c.at}`)
        return
      }
      if (Node.isIdentifier(n)) {
        const decl = declOf(n)
        if (!decl || inner.some((f) => isWithin(decl, f as FunctionLike))) return
        const v = env.get(decl)
        const arg = !v && Node.isParameterDeclaration(decl) ? frame.params.get(decl) : undefined
        const state = v && v !== 'unknown' ? { key: v.byName ?? v.argKey, versions: v.versions } : arg ? { key: arg.key, versions: arg.versions } : {}
        if (state.key) parts.add(`${n.getText()}=${state.key}`)
        const read = readPath(n)
        for (const [p, at] of Object.entries(state.versions ?? {})) if (overlaps(read, p)) parts.add(`${n.getText()}.${p}@${at}`)
        // Changes earlier in this function, and in the caller before this call.
        for (const c of this.changeSites(frame.fn)) if (c.decl === decl && c.at < expr.getStart() && overlaps(read, c.path)) parts.add(`after ${n.getText()}.${c.path}@${c.at}`)
        for (const c of arg?.changes ?? []) if (overlaps(read, c.path)) parts.add(`after ${n.getText()}.${c.path}@${c.at}`)
        // A variable holding a value worked out earlier (`const ok = isValid(order)`) depends on what that read.
        if (v && v !== 'unknown' && v.deps) for (const d of v.deps.split(',')) parts.add(d)
        if (frame.prefix && isWithin(decl, frame.fn) && (v === 'unknown' || (v && v.byName) || this.substitute(n, frame, env, 0) === undefined)) local = true
        return
      }
      n.forEachChild((c) => visit(c, inner))
    }
    visit(expr, [])
    for (const p of this.changedParts(expr, frame)) parts.add(p)
    // Keyed by the function and its arguments, so the same call in two places is one question.
    if (local) parts.add(`in ${frame.name}${frame.argsKey}`)
    return parts.size ? [...parts].sort().join(',') : undefined
  }

  /**
   * Changes that can happen before this check and change what it reads, each as an
   * \`after …\` part: a write to a field it reads, on any object (an alias can be the same
   * object); a change to a whole object whose type has that field; and, for a check that
   * calls something (a lookup), a call to code Vantle can't see. A change in a callback,
   * which can run between any two checks, makes this check a question of its own.
   */
  private changedParts(expr: Node, frame: Frame): string[] {
    const changes = [...(frame.outer ?? []), ...this.changes.before(frame.fn, expr)]
    if (!changes.length) return []
    const reads: { f: string | undefined; on?: import('ts-morph').Type }[] = []
    let lookup = false
    const visit = (n: Node) => {
      if (n !== expr && isFunctionLike(n)) return
      if (Node.isPropertyAccessExpression(n)) {
        // A getter can read anything on its object.
        const getter = n.getNameNode().getSymbol()?.getDeclarations().some((d) => Node.isGetAccessorDeclaration(d))
        reads.push({ f: getter ? undefined : n.getName(), on: n.getExpression().getType() })
      } else if (Node.isElementAccessExpression(n)) {
        const a = n.getArgumentExpression()
        reads.push({ f: a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) ? a.getLiteralValue() : undefined, on: n.getExpression().getType() })
      } else if (Node.isIdentifier(n)) {
        // A module variable, or one a closure captured, read as a field of its own.
        const v = outsideVariable(n, frame.fn)
        if (v) reads.push({ f: v })
      } else if (Node.isCallExpression(n) && !pureCall(n)) lookup = true
      n.forEachChild(visit)
    }
    visit(expr)
    const out: string[] = []
    for (const c of changes) {
      const hits =
        (lookup && c.effect) ||
        reads.some(({ f, on }) => (f === undefined ? c.anyField || c.fields.size > 0 || c.types.length > 0 : c.anyField || c.fields.has(f) || c.types.some((t) => mayHold(t, f, on))))
      if (hits) out.push(c.floating ? `after ~${changeKey(c)}@${frame.prefix}${expr.getStart()}` : `after ${changeKey(c)}`)
    }
    return out
  }

  /** True when the code shows one of an inlined helper's own variables by name. */
  private showsLocalNames(expr: Node, frame: Frame, env: Env): boolean {
    return !!frame.prefix && !!this.identityOf(expr, frame, env)?.includes(`in ${frame.name}${frame.argsKey}`)
  }

  /** Decision boxes reachable from `entry` before it leaves through `exit`. */
  private boxesUntil(entry: string, exit: Exit): Set<string> {
    const stops = new Set(exit.kind === 'branch' ? [exit.yes, exit.no] : [])
    const out = new Map<string, string[]>()
    for (const e of this.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    const found = new Set<string>()
    const stack = [entry]
    const seen = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id) || stops.has(id)) continue
      seen.add(id)
      if (this.nodes.get(id)?.kind === 'decision') found.add(id)
      stack.push(...(out.get(id) ?? []))
    }
    return found
  }

  /** Records code the chart can't show, once per place. */
  private note(kind: NotCharted['kind'], at: Node, frame: Frame, code: string, note: string): string {
    const file = relPath(this.vp.root, at.getSourceFile())
    const key = `${kind}:${file}:${at.getStart()}`
    if (!this.notCharted.has(key)) this.notCharted.set(key, { kind, file, line: at.getStartLineNumber(), symbol: frame.name, code, note })
    return key
  }

  /** `returned` is the expression a `return` hands back, when there is one. */
  private outcome(value: string, at: Node, frame: Frame, returned?: Node, named?: string): string {
    const v = normalizeCode(value)
    const id = `${this.flowId}:outcome:${v === 'true' || v === 'false' ? v : shortHash(named ? `${v}#${named}` : v)}`
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind: 'outcome', rawLabel: v, value: v, source: this.sourceRef(at, frame), spans: [] })
    }
    const node = this.nodes.get(id)!
    if (returned && node.kind === 'outcome') {
      const span = this.span(returned, frame)
      if (!node.spans?.some((s) => s.file === span.file && s.start === span.start)) node.spans = [...(node.spans ?? []), span]
    }
    return id
  }

  private span(node: Node, frame?: Frame): Span {
    const file = relPath(this.vp.root, node.getSourceFile())
    const text = node.getText()
    const span: Span = { file, start: node.getStart(), end: node.getEnd(), text, ...(frame ? { owner: `${relPath(this.vp.root, frame.fn.getSourceFile())}#${frame.name}` } : {}) }
    // Record the function the expression is in, and which copy it is when it appears more than once.
    let ranges = this.ranges.get(file)
    if (!ranges) this.ranges.set(file, (ranges = expressionRanges(file, node.getSourceFile().getFullText())))
    const fn = ranges.get(`${span.start}:${span.end}`)
    if (fn === undefined) return span
    span.fn = fn
    const found = occurrences(node.getSourceFile().getFullText(), text, ranges, fn)
    if (found.length > 1 && found.includes(span.start)) Object.assign(span, { nth: found.indexOf(span.start), of: found.length })
    return span
  }

  private fallOff(ctx: Ctx, fn: FunctionLike): string {
    return ctx.exit.kind === 'branch' ? ctx.exit.no : this.outcome('undefined', fn, ctx.frame)
  }

  private uniqueId(id: string): string {
    if (!this.nodes.has(id)) return id
    let n = 2
    while (this.nodes.has(`${id}~${n}`)) n++
    return `${id}~${n}`
  }

  // ---- text -------------------------------------------------------------

  /**
   * The code for `expr`, rewritten in terms of the entry function's parameters:
   * an inlined function's parameters become the caller's arguments, and local
   * constants become their initial values.
   */
  private text(expr: Node, frame: Frame, env: Env = EMPTY_ENV, guard = 0): string {
    const start = expr.getStart()
    let out = expr.getText()
    const replacements: { start: number; end: number; text: string }[] = []
    // Inside a nested function (a callback), only variables from outside it are rewritten.
    const inner: Node[] = []
    let ownThis = false
    const visit = (node: Node) => {
      if (node !== expr && isFunctionLike(node)) {
        const wasOwnThis = ownThis
        inner.push(node)
        if (!Node.isArrowFunction(node)) ownThis = true
        node.forEachChild(visit)
        inner.pop()
        ownThis = wasOwnThis
        return
      }
      // `cfg.level` of an unchanged `const cfg = { level }` reads as the value of `level`.
      if (Node.isPropertyAccessExpression(node) && Node.isIdentifier(node.getExpression())) {
        const decl = declOf(node.getExpression())
        const v = decl && !inner.some((f) => isWithin(decl, f as FunctionLike)) ? env.get(decl) : undefined
        const prop = v && v !== 'unknown' && !v.versions ? v.props?.[node.getName()] : undefined
        if (prop) {
          replacements.push({ start: node.getStart() - start, end: node.getEnd() - start, text: prop.simple ? prop.text : `(${prop.text})` })
          return
        }
      }
      if (node.getKind() === SyntaxKind.ThisKeyword && frame.receiver && !ownThis) {
        const r = frame.receiver
        replacements.push({ start: node.getStart() - start, end: node.getEnd() - start, text: r.simple ? r.text : `(${r.text})` })
        return
      }
      if (Node.isIdentifier(node)) {
        const decl = inner.length ? declOf(node) : undefined
        if (decl && inner.some((f) => isWithin(decl, f as FunctionLike))) return
        const replacement = this.substitute(node, frame, env, guard)
        if (replacement === undefined) return
        // `{ id }` becomes `{ id: <value> }`, keeping the property's name.
        const parent = node.getParent()
        const text = Node.isShorthandPropertyAssignment(parent) ? `${node.getText()}: ${replacement}` : replacement
        replacements.push({ start: node.getStart() - start, end: node.getEnd() - start, text })
        return
      }
      node.forEachChild(visit)
    }
    visit(expr)
    for (const r of replacements.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, r.start) + r.text + out.slice(r.end)
    }
    return normalizeCode(out)
  }

  private substitute(id: Node, frame: Frame, env: Env, guard: number): string | undefined {
    const parent = id.getParent()
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return undefined
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return undefined
    // Names being declared, not read.
    if (parent && (Node.isParameterDeclaration(parent) || Node.isVariableDeclaration(parent) || Node.isBindingElement(parent) || Node.isFunctionDeclaration(parent)) && parent.getNameNode() === id) return undefined
    const decl = declOf(id)
    if (!decl) return undefined
    // A local variable's value at this point.
    const tracked = env.get(decl)
    if (tracked !== undefined) {
      if (tracked === 'unknown') return undefined
      return tracked.simple ? tracked.text : `(${tracked.text})`
    }
    if (Node.isParameterDeclaration(decl)) {
      const arg = frame.params.get(decl)
      if (!arg) return undefined
      return arg.simple ? arg.text : `(${arg.text})`
    }
    if (Node.isVariableDeclaration(decl) && guard < 5 && isWithin(decl, frame.fn)) {
      const list = decl.getVariableStatement()
      const init = decl.getInitializer()
      if (list?.getDeclarationKind() === VariableDeclarationKind.Const && init && !isFunctionLike(init) && !isObjectLike(init) && !this.changedBeforeRead(decl, init, frame.fn)) {
        const text = this.text(init, frame, env, guard + 1)
        // A long constant reads better by its name.
        if (text.length > MAX_INLINE_TEXT) return undefined
        return isSimple(init) ? text : `(${text})`
      }
    }
    return undefined
  }

  private calls(expr: Node): CallRef[] {
    const refs: CallRef[] = []
    const visit = (node: Node) => {
      if (Node.isCallExpression(node)) {
        const { origin, filePath } = callOrigin(node, (p) => this.isRepoPath(p))
        if (origin !== 'builtin') {
          refs.push({
            callee: normalizeCode(node.getExpression().getText()),
            file: origin === 'repo' && filePath ? relPath(this.vp.root, filePath) : null,
            external: origin !== 'repo',
          })
        }
      }
      node.forEachChild(visit)
    }
    visit(expr)
    return refs
  }

  // ---- bookkeeping ------------------------------------------------------

  sourceRef(node: Node, frame: Frame): SourceRef {
    const file = relPath(this.vp.root, node.getSourceFile())
    const dir = path.posix.dirname(file)
    return { file, line: node.getStartLineNumber(), module: dir === '' ? '.' : dir, symbol: frame.name }
  }

  sourceHash(): string {
    const parts = [...this.files]
      .map((f) => `${relPath(this.vp.root, f)}\n${f.getFullText()}`)
      .sort()
    return shortHash(parts.join('\n---\n'), 12)
  }

  private isRepoPath(filePath: string): boolean {
    return filePath.startsWith(this.vp.root + path.sep) && !filePath.includes('/node_modules/')
  }

  private warn(message: string) {
    this.warnings.add(message)
  }

  private reachableFrom(root: string): Set<string> {
    const out = new Map<string, string[]>()
    for (const e of this.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    const seen = new Set<string>()
    const stack = [root]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(out.get(id) ?? []))
    }
    return seen
  }
}

// ---- helpers ------------------------------------------------------------

const recursiveCache = new WeakMap<FunctionLike, boolean>()

/** True when the function can reach itself through calls to other repo functions. */
function isRecursive(fn: FunctionLike, isRepoPath: (p: string) => boolean): boolean {
  const cached = recursiveCache.get(fn)
  if (cached !== undefined) return cached
  const seen = new Set<FunctionLike>()
  const stack: FunctionLike[] = [fn]
  let found = false
  while (stack.length && !found && seen.size < 500) {
    const current = stack.pop()!
    current.getBody()?.forEachDescendant((node) => {
      if (found || !Node.isCallExpression(node)) return
      const target = resolveCallee(node)
      if (!target || !isRepoPath(target.getSourceFile().getFilePath())) return
      if (target === fn) found = true
      else if (!seen.has(target)) {
        seen.add(target)
        stack.push(target)
      }
    })
  }
  recursiveCache.set(fn, found)
  return found
}

function sameSpan(a: Span, b: Span): boolean {
  return a.file === b.file && a.start === b.start && a.end === b.end
}

function valueKey(v: Value | undefined): string {
  if (v === undefined) return '-'
  if (v === 'unknown') return '?'
  const versions = v.versions ? Object.entries(v.versions).sort(([a], [b]) => a.localeCompare(b)).map(([p, at]) => `${p}@${at}`) : []
  return `${v.text}${v.byName ? `=${v.byName}` : ''}${v.argKey ? `~${v.argKey}` : ''}${versions.length ? `{${versions.join(',')}}` : ''}`
}

function declarationName(decl: Node): string {
  if (isFunctionLike(decl)) return 'this'
  return Node.isVariableDeclaration(decl) || Node.isBindingElement(decl) || Node.isParameterDeclaration(decl) ? decl.getNameNode().getText() : decl.getText()
}

function set(env: Env, decl: Node, value: Value): Env {
  const out = new Map(env)
  out.set(decl, value)
  return out
}

/**
 * Drops variables that aren't used at or after `position`, and changes to
 * properties that aren't read again, so they don't split the chart.
 */
function prune(env: Env, lastUse: Map<Node, number>, propUse: Map<Node, Map<string, number>>, position: number): Env {
  let out: Map<Node, Value> | undefined
  for (const [decl, value] of env) {
    if ((lastUse.get(decl) ?? -1) < position) continue
    let kept = value
    if (value !== 'unknown' && value.versions) {
      const later = [...(propUse.get(decl) ?? [])].filter(([, at]) => at >= position).map(([path]) => path)
      const versions = Object.fromEntries(Object.entries(value.versions).filter(([p]) => p === '*' || later.some((r) => overlaps(r, p))))
      if (Object.keys(versions).length) kept = { ...value, versions }
      else if (value.before === 'absent') continue
      else kept = value.before ?? { text: value.text, simple: value.simple }
    }
    ;(out ??= new Map()).set(decl, kept)
  }
  return out ?? EMPTY_ENV
}

/** True when a value carries a change made at a place in the code, not only a mark left by an earlier join (already shown there). */
/**
 * Whether a step box should say what a variable holds as a join forgets it. Not
 * when it holds what it started with, nor when an earlier join already forgot it
 * (its step box said what was set; this one would only say \`path = path\`).
 */
function worthShowing(decl: Node, v: Exclude<Value, 'unknown'>): boolean {
  if (madeHere(v)) return true
  if (v.byName) return !(v.literal === undefined && /^(join|wide):\d+$/.test(v.byName))
  return v.text !== declarationName(decl)
}

/**
 * Whether an argument reads safely without parentheses where its parameter is used
 * (\`arg.url\`). A plain name is simple only if what it was replaced with is: \`request\`
 * holding \`ok ? source : undefined\` isn't.
 */
function simpleArg(arg: Node, text: string, simpleAsWritten: boolean): boolean {
  if (!simpleAsWritten) return false
  return text === arg.getText() || isChain(text) || foldConstant(text).ok
}

/** Text that is one chain of names, calls and indexing (\`a.b(c).d[0]\`), with nothing outside brackets that binds looser. */
function isChain(text: string): boolean {
  let depth = 0
  let quote = ''
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (depth === 0 && !/[\w$.?]/.test(ch)) return false
  }
  // \`a ? b : c\` has spaces, so a \`?\` left here is optional chaining.
  return depth === 0 && /^[\w$]/.test(text)
}

function madeHere(v: Exclude<Value, 'unknown'>): boolean {
  return Object.values(v.versions ?? {}).some((at) => /^\d+$/.test(at))
}

function envKey(env: Env): string {
  return [...env]
    .map(([decl, v]) => `${decl.getStart()}=${valueKey(v)}`)
    .sort()
    .join('|')
}

/** Marks these variables as unknown. */
function forget(env: Env, decls: Set<Node>): Env {
  if (![...decls].some((d) => env.has(d))) return env
  const out = new Map(env)
  for (const d of decls) if (out.has(d)) out.set(d, 'unknown')
  return out
}

/** What a name refers to. In `{ id }`, that's the variable `id`, not the property. */
function declOf(id: Node): Node | undefined {
  const parent = id.getParent()
  if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === id) return parent.getValueSymbol()?.getDeclarations()[0]
  return id.getSymbol()?.getDeclarations()[0]
}

/** In a method or function (not an arrow), `this` is tracked like a variable, keyed by the function. */
function thisKey(node: Node, fn: FunctionLike): Node | undefined {
  return node.getKind() === SyntaxKind.ThisKeyword && !Node.isArrowFunction(fn) && enclosingThisOwner(node) === fn ? fn : undefined
}

/** The function whose `this` a `this` keyword refers to. */
function enclosingThisOwner(node: Node): Node | undefined {
  for (let p = node.getParent(); p; p = p.getParent()) if (isFunctionLike(p) && !Node.isArrowFunction(p)) return p
  return undefined
}

/** The local variable or parameter of `fn` an expression names, or `fn` itself for `this`. */
function localDeclaration(expr: Node, fn: FunctionLike): Node | undefined {
  const self = thisKey(expr, fn)
  if (self) return self
  if (!Node.isIdentifier(expr)) return undefined
  const decl = declOf(expr)
  if (!decl || (!Node.isVariableDeclaration(decl) && !Node.isBindingElement(decl) && !Node.isParameterDeclaration(decl)) || !isWithin(decl, fn)) return undefined
  return decl
}


/**
 * Variables and parameters of `fn` whose object `node` changes, with the
 * property changed: `x.a = 1` and `x.a.b = 1` change `a`, `x[k]++` and
 * `x.push(...)` change `*` (the whole object), as do `delete x[k]` and
 * `Object.assign(x, ...)`.
 */
function mutatedIn(node: Node, fn: FunctionLike, statement = false, conservative = false): Map<Node, Set<string>> {
  const out = new Map<Node, Set<string>>()
  const record = (decl: Node | undefined, path: string) => {
    if (decl) out.set(decl, new Set([...(out.get(decl) ?? []), path]))
  }
  /** The variable at the root of `x.a.b`, and the path below it (`a.b`, or `*` for `x` itself). */
  const rootOf = (target: Node): { decl?: Node; path: string } => {
    let t = unwrapAny(target)
    const parts: string[] = []
    let exact = true
    while (Node.isPropertyAccessExpression(t) || Node.isElementAccessExpression(t)) {
      if (Node.isPropertyAccessExpression(t)) parts.unshift(t.getName())
      else {
        const a = t.getArgumentExpression()
        if (a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))) parts.unshift(a.getLiteralValue())
        else {
          // `x[k] = ...` changes some property of whatever is above it.
          parts.length = 0
          exact = false
        }
      }
      t = unwrapAny(t.getExpression())
    }
    const decl = localDeclaration(t, fn)
    return { decl, path: parts.length && exact ? parts.join('.') : parts.length ? parts.join('.') : '*' }
  }
  const add = (target: Node) => {
    const { decl, path } = rootOf(target)
    record(decl, path)
  }
  const top = unwrapAny(Node.isAwaitExpression(unwrapAny(node)) ? (unwrapAny(node) as import('ts-morph').AwaitExpression).getExpression() : node)
  if (statement && Node.isCallExpression(top)) {
    const callee = unwrapAny(top.getExpression())
    const target = resolveCallee(top)
    const known = target && target.getBody() && !target.getSourceFile().isInNodeModules() && !target.getSourceFile().isDeclarationFile()
    // A method called only for its effect (`user.ban()`) may change the object it's called on,
    // unless it's one known not to (`forEach`, `log`, `then`), or one in the repo that doesn't
    // (`this.validateEmail(u)`).
    if (Node.isPropertyAccessExpression(callee) && !NON_MUTATING_METHODS.has(callee.getName()) && !(known && !changesReceiver(target!))) add(callee.getExpression())
    // A helper in the repo that sets properties of what it's given (`applyDefaults(opts)`) changes it.
    // Other functions (`track(user)`) are assumed not to.
    if (known) {
      top.getArguments().forEach((a, i) => {
        const param = target!.getParameters()[i]
        if (param && changesParam(target!, param)) add(a)
      })
    } else if (conservative && !/^console\./.test(top.getExpression().getText())) {
      // With `conservative`, a function Vantle can't see into might change what it's given.
      for (const a of top.getArguments()) add(a)
    }
  }
  const visit = (n: Node) => {
    if (n !== node && isFunctionLike(n)) return
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind()
      const left = unwrapAny(n.getLeft())
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment && (Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left))) add(left)
    } else if (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) {
      const op = n.getOperatorToken()
      const operand = unwrapAny(n.getOperand())
      if ((op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) && (Node.isPropertyAccessExpression(operand) || Node.isElementAccessExpression(operand))) add(operand)
    } else if (Node.isDeleteExpression(n)) {
      add(n.getExpression())
    } else if (Node.isCallExpression(n)) {
      const callee = unwrapAny(n.getExpression())
      if (Node.isPropertyAccessExpression(callee)) {
        // `x.push()` changes x; `x.list.push()` changes x's `list`.
        if (MUTATING_METHODS.has(callee.getName())) add(callee.getExpression())
        if (callee.getText() === 'Object.assign' && n.getArguments()[0]) add(n.getArguments()[0]!)
      }
    }
    n.forEachChild(visit)
  }
  visit(node)
  return out
}

/**
 * A \`new\` that could throw by itself: not the error a \`throw\` builds (\`throw new X(...)\`),
 * which is the throw Vantle draws, and not a built-in that can't throw (\`new Error(m)\`, \`new Map()\`).
 */
function unseenNew(node: Node): boolean {
  if (!Node.isNewExpression(node) || Node.isThrowStatement(node.getParent())) return false
  return !SAFE_CONSTRUCTORS.has(node.getExpression().getText())
}

const SAFE_CONSTRUCTORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date'])

/** True when \`node\` sits in a function written inside \`outer\`. */
function insideFunction(node: Node, outer: Node): boolean {
  for (let n = node.getParent(); n && n !== outer; n = n.getParent()) if (isFunctionLike(n)) return true
  return false
}

const changesParamCache = new WeakMap<Node, boolean>()

/** True when `fn` sets a property of `param`, or calls a changing method on it. */
function changesParam(fn: FunctionLike, param: Node): boolean {
  const cached = changesParamCache.get(param)
  if (cached !== undefined) return cached
  let found = false
  fn.getBody()?.forEachDescendant((n, traversal) => {
    if (found) {
      traversal.stop()
      return
    }
    if (!Node.isExpressionStatement(n)) return
    if ([...mutatedIn(n.getExpression(), fn)].some(([decl]) => decl === param)) found = true
  })
  changesParamCache.set(param, found)
  return found
}

const changesReceiverCache = new WeakMap<Node, boolean>()

/** True when a method changes \`this\`: it sets a property of it anywhere in its body, or calls a method on it that does. */
function changesReceiver(fn: FunctionLike): boolean {
  return receiverChanges(fn, new Set()).found
}

/** As \`throwsFrom\`: only sure answers are cached, so recursion never sticks as "doesn't change it". */
function receiverChanges(fn: FunctionLike, active: Set<Node>): { found: boolean; sure: boolean } {
  const cached = changesReceiverCache.get(fn)
  if (cached !== undefined) return { found: cached, sure: true }
  // An arrow function's \`this\` isn't the receiver; assume the worst.
  if (Node.isArrowFunction(fn)) return { found: true, sure: true }
  if (active.has(fn)) return { found: false, sure: false }
  active.add(fn)
  let found = false
  let sure = true
  const body = fn.getBody()
  // Writes anywhere in the body: \`this.n = 1\`, \`return this.n++\`, \`this.list.push(x)\`.
  if (body && [...mutatedIn(body, fn)].some(([decl]) => decl === fn)) found = true
  body?.forEachDescendant((n, traversal) => {
    if (found) return traversal.stop()
    if (n !== fn && isFunctionLike(n) && !Node.isArrowFunction(n)) {
      traversal.skip()
      return
    }
    if (!Node.isCallExpression(n)) return
    const callee = unwrapAny(n.getExpression())
    if (!Node.isPropertyAccessExpression(callee) || thisKey(unwrapAny(callee.getExpression()), fn) !== fn || NON_MUTATING_METHODS.has(callee.getName())) return
    const target = resolveCallee(n)
    const known = target && target.getBody() && !target.getSourceFile().isInNodeModules() && !target.getSourceFile().isDeclarationFile()
    if (!known) {
      found = true
      return
    }
    const r = receiverChanges(target!, active)
    if (r.found) found = true
    else if (!r.sure) sure = false
  })
  active.delete(fn)
  if (found || sure) changesReceiverCache.set(fn, found)
  return { found, sure: found || sure }
}

/** A catch that does nothing but rethrow its own error, perhaps after logging it. */
function isRethrow(handler: import('ts-morph').CatchClause): boolean {
  const name = handler.getVariableDeclaration()?.getName()
  const stmts = handler.getBlock().getStatements()
  const last = stmts.at(-1)
  if (!name || !last || !Node.isThrowStatement(last) || last.getExpression()?.getText() !== name) return false
  return stmts.slice(0, -1).every((st) => Node.isExpressionStatement(st) && !st.getFirstDescendant((n) => Node.isThrowStatement(n) || Node.isReturnStatement(n)))
}

/** True when a function has a \`throw\` inside a callback it passes to a call. */
function throwsInCallbacks(fn: FunctionLike): boolean {
  return !!fn.getBody()?.getFirstDescendant((n) => isFunctionLike(n) && Node.isCallExpression(n.getParent()) && !!n.getFirstDescendantByKind(SyntaxKind.ThrowStatement))
}

function unwrapAny(node: Node): Node {
  let n = node
  while (Node.isParenthesizedExpression(n) || Node.isNonNullExpression(n) || Node.isAsExpression(n)) n = n.getExpression()
  return n
}

/** An effect the chart can't show, such as a property write or a method call, other than logging. */
function firstEffect(stmt: Node): Node | undefined {
  let found: Node | undefined
  const visit = (n: Node) => {
    if (found || isFunctionLike(n)) return
    if (Node.isCallExpression(n) && !/^console\./.test(n.getExpression().getText())) found = n
    else if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind()
      const left = unwrapAny(n.getLeft())
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment && (Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left))) found = n
    } else if (Node.isDeleteExpression(n)) found = n
    n.forEachChild(visit)
  }
  visit(stmt)
  return found
}

/**
 * True when evaluating the expression twice may give different answers even
 * with the same inputs: calls with no arguments (`next()`, `rng()`), time,
 * randomness and `new`. Calls with arguments are taken to be lookups.
 */
function volatile(expr: Node): boolean {
  let found = false
  const visit = (n: Node) => {
    if (found || (n !== expr && isFunctionLike(n))) return
    if (Node.isCallExpression(n) && VOLATILE_CALL.test(calleeName(n))) found = true
    else if (Node.isNewExpression(n)) found = true
    else if (/^(Date\.now|Math\.random|performance\.now|crypto\.)/.test(n.getText()) && (Node.isPropertyAccessExpression(n) || Node.isCallExpression(n))) found = true
    n.forEachChild(visit)
  }
  visit(expr)
  return found
}

/** True for uses of a whole object that can't change any box: logging it, or passing it to a call made only for its effect. */
function readsNothing(id: Node): boolean {
  const call = id.getParent()
  if (!Node.isCallExpression(call) || !call.getArguments().includes(id)) return false
  if (/^console\./.test(call.getExpression().getText())) return true
  let top: Node = call
  for (let p = top.getParent(); p && (Node.isAwaitExpression(p) || Node.isParenthesizedExpression(p) || Node.isVoidExpression(p)); p = p.getParent()) top = p
  return Node.isExpressionStatement(top.getParent())
}

/** The properties a helper reads of one of its parameters (`*` when it uses the object whole). */
function paramReads(fn: FunctionLike, param: Node): string[] {
  const out = new Set<string>()
  fn.getBody()?.forEachDescendant((n) => {
    if (out.has('*') || !Node.isIdentifier(n) || declOf(n) !== param) return
    const prop = propertyRead(n)
    if (prop) out.add(prop)
    else {
      const parent = n.getParent()
      const pattern = Node.isVariableDeclaration(parent) && parent.getInitializer() === n ? parent.getNameNode() : undefined
      if (Node.isObjectBindingPattern(pattern)) for (const el of pattern.getElements()) out.add(el.getPropertyNameNode()?.getText() ?? el.getName())
      else if (Node.isCallExpression(parent) && !readsNothing(n)) out.add('*')
    }
  })
  return [...out]
}

/**
 * When `x` is passed whole to a call that is the condition of a check
 * (`check`), or to a call that's returned (`returned`, with which argument it is).
 */
function wholeUse(id: Node): { kind: 'check' } | { kind: 'returned'; call: CallExpression; index?: number } | undefined {
  const parent = id.getParent()
  let call: Node | undefined = parent
  let index: number | undefined
  if (Node.isCallExpression(parent)) {
    const i = parent.getArguments().indexOf(id)
    if (i < 0) return undefined
    index = i
  } else if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id && Node.isCallExpression(parent.getParent())) {
    call = parent.getParent()
  } else return undefined
  if (!Node.isCallExpression(call)) return undefined
  let top: Node = call
  for (let p = top.getParent(); p && (Node.isParenthesizedExpression(p) || Node.isAwaitExpression(p) || Node.isNonNullExpression(p) || (Node.isPrefixUnaryExpression(p) && p.getOperatorToken() === SyntaxKind.ExclamationToken)); p = p.getParent()) top = p
  const holder = top.getParent()
  if ((Node.isIfStatement(holder) || Node.isWhileStatement(holder) || Node.isDoStatement(holder) || Node.isSwitchStatement(holder)) && holder.getExpression() === top) return { kind: 'check' }
  if (Node.isConditionalExpression(holder) && holder.getCondition() === top) return { kind: 'check' }
  if (Node.isReturnStatement(holder) || Node.isArrowFunction(holder)) return { kind: 'returned', call, index }
  return undefined
}

/** True when `x` is the root of the left side of an assignment, as in `x.a.b = 1`. */
function isWriteTarget(id: Node): boolean {
  let top: Node = id
  for (let p = top.getParent(); p && (Node.isPropertyAccessExpression(p) || Node.isElementAccessExpression(p)) && p.getExpression() === top; p = p.getParent()) top = p
  const parent = top.getParent()
  if (!Node.isBinaryExpression(parent) || parent.getLeft() !== top) return false
  return parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
}

/** For `x` in `x.a` or `x['a']`, the property `a`. */
/** The property path read off `x` in `x.a.b` (`a.b`), or `*` when the whole object is used. */
function readPath(id: Node): string {
  return propertyRead(id) ? accessPath(id) : '*'
}

/** `a.b` for `x` in `x.a.b` or `x['a'].b`, stopping at a computed key or a call. */
function accessPath(id: Node): string {
  const parts: string[] = []
  let n: Node = id
  for (let p = n.getParent(); p; p = p.getParent()) {
    let name: string | undefined
    if (Node.isPropertyAccessExpression(p) && p.getExpression() === n) name = p.getName()
    else if (Node.isElementAccessExpression(p) && p.getExpression() === n) {
      const a = p.getArgumentExpression()
      name = a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) ? a.getLiteralValue() : undefined
    }
    if (name === undefined) break
    // `x.a.has(...)` reads `a`; the method name isn't data.
    if (Node.isCallExpression(p.getParent()) && (p.getParent() as CallExpression).getExpression() === p) break
    parts.push(name)
    n = p
  }
  return parts.length ? parts.join('.') : '*'
}

/** True when a read of path `a` can see a change to path `b`: one contains the other. */
function overlaps(a: string, b: string): boolean {
  return a === '*' || b === '*' || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

function propertyRead(id: Node): string | undefined {
  const parent = id.getParent()
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) return parent.getName()
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === id) {
    const arg = parent.getArgumentExpression()
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return arg.getLiteralValue()
  }
  return undefined
}

/** Calls whose names say they consume or sample something, so each call can answer differently. */

function calleeName(call: CallExpression): string {
  const callee = unwrapAny(call.getExpression())
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText()
}

function isObjectLike(expr: Node): boolean {
  const e = unwrapAny(expr)
  return Node.isObjectLiteralExpression(e) || Node.isArrayLiteralExpression(e) || Node.isNewExpression(e)
}

/** The value a case expression stands for, as JSON, when the type checker knows it (enum members, constants). */
function constantValue(expr: Expression): string | undefined {
  const type = expr.getType()
  if (!type.isLiteral() && !type.isEnumLiteral()) return undefined
  const value = type.getLiteralValue()
  return typeof value === 'string' || typeof value === 'number' ? JSON.stringify(value) : undefined
}

function oneLine(text: string): string {
  const line = normalizeCode(text)
  return line.length > 100 ? `${line.slice(0, 97)}…` : line
}

/** Fails loudly when the chart is broken: an arrow to a missing box, or a box without its exits. */
function checkIntegrity(root: string, nodes: FlowNode[], edges: FlowEdge[]) {
  const ids = new Set(nodes.map((n) => n.id))
  const problems: string[] = []
  if (!ids.has(root)) problems.push(`the start points at a missing box (${root})`)
  const out = new Map<string, FlowEdge[]>()
  for (const e of edges) {
    if (!ids.has(e.to)) problems.push(`an arrow from ${e.from} points at a missing box (${e.to})`)
    out.set(e.from, [...(out.get(e.from) ?? []), e])
  }
  for (const n of nodes) {
    const exits = out.get(n.id) ?? []
    if (n.kind === 'decision' && n.branch === 'boolean' && (exits.length !== 2 || !exits.some((e) => e.label === 'yes') || !exits.some((e) => e.label === 'no'))) problems.push(`box ${n.id} doesn't have exactly a yes and a no arrow`)
    if (n.kind === 'decision' && n.branch === 'switch' && exits.length < 1) problems.push(`switch ${n.id} has no arrows`)
    if ((n.kind === 'action' || n.kind === 'opaque') && exits.length !== 1) problems.push(`step ${n.id} doesn't have exactly one next arrow`)
    if (n.kind === 'outcome' && exits.length) problems.push(`outcome ${n.id} has arrows out of it`)
  }
  if (problems.length) throw new Error(`Vantle built a broken chart, which is a bug in Vantle: ${problems.slice(0, 3).join('; ')}.`)
}

/** Local variables that `node` assigns or updates anywhere inside it. */
function assignedIn(node: Node, fn: FunctionLike): Set<Node> {
  const out = new Set<Node>()
  const check = (target: Node) => {
    const decl = localDeclaration(target, fn)
    if (decl) out.add(decl)
  }
  const visit = (n: Node) => {
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind()
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment) check(n.getLeft())
    } else if (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) {
      const op = n.getOperatorToken()
      if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) check(n.getOperand())
    }
    n.forEachChild(visit)
  }
  visit(node)
  return out
}

/** Constants longer than this are shown by name instead of by value. */
const MAX_INLINE_TEXT = 160
/** A helper's argument or a variable's value longer than this is shown by name in boxes, so labels stay short. */
const MAX_SHOWN_VALUE = 60

const CONSTANT = /^(?:\s|\d+(?:\.\d+)?|true|false|null|undefined|'[^'\\]*'|"[^"\\]*"|[!<>=&|+\-*/%()?:])*$/

/** Evaluates an expression made only of literals and operators, like `!false` or `-1 < 0`. */
export function foldConstant(text: string): { ok: true; value: unknown } | { ok: false; value?: undefined } {
  if (!CONSTANT.test(text) || !/\S/.test(text)) return { ok: false }
  try {
    return { ok: true, value: new Function(`"use strict"; return (${text})`)() }
  } catch {
    return { ok: false }
  }
}

/** The first line of a loop, without its body: `for (const item of items)`. */
function loopHeader(stmt: Statement): string {
  const text = stmt.getText()
  const body = (stmt as Statement & { getStatement(): Statement }).getStatement()
  return normalizeCode(text.slice(0, body.getStart() - stmt.getStart()))
}

/**
 * The expression to record a box's answer from. Conditions are unwrapped past
 * `await`, but the probe must wrap the `await` too: otherwise it records the
 * promise, which is always truthy, instead of what it resolves to.
 */
function awaited(expr: Node): Node {
  let top = expr
  for (let p = expr.getParent(); p && (Node.isParenthesizedExpression(p) || Node.isAwaitExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p)); p = p.getParent()) {
    if (Node.isAwaitExpression(p)) top = p
  }
  return top
}

function unwrap(expr: Expression): Expression {
  let e: Expression = expr
  while (Node.isParenthesizedExpression(e) || Node.isAwaitExpression(e) || Node.isAsExpression(e) || Node.isNonNullExpression(e)) {
    e = e.getExpression()
  }
  return e
}

const SIMPLE_KINDS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.ParenthesizedExpression,
])

/** True when the text can be dropped into another expression without parentheses. */
function isSimple(node: Node): boolean {
  return SIMPLE_KINDS.has(node.getKind())
}

function isWithin(node: Node, fn: FunctionLike): boolean {
  return node.getSourceFile() === fn.getSourceFile() && node.getPos() >= fn.getPos() && node.getEnd() <= fn.getEnd()
}

/** True when every case of a union-typed switch is handled, so there's no "other" branch. */
function isExhaustive(stmt: SwitchStatement): boolean {
  const type = stmt.getExpression().getType()
  const members = type.isUnion() ? type.getUnionTypes() : [type]
  if (!members.every((t) => t.isLiteral() || t.isEnumLiteral())) return false
  // Any number can be assigned to a numeric enum, so a switch over one is never closed.
  if (members.some((t) => t.isEnumLiteral() && typeof t.getLiteralValue() === 'number')) return false
  const handled = new Set(
    stmt.getClauses().flatMap((c) => {
      if (!Node.isCaseClause(c)) return []
      const e = c.getExpression()
      if (Node.isStringLiteral(e) || Node.isNumericLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return [String(e.getLiteralValue())]
      // Enum members and constants: their type is the literal they stand for.
      const t = e.getType()
      return t.isLiteral() || t.isEnumLiteral() ? [String(t.getLiteralValue())] : []
    }),
  )
  return members.every((t) => handled.has(String(t.getLiteralValue())))
}

const KIND_SHORT: Partial<Record<SyntaxKind, string>> = {
  [SyntaxKind.Block]: 'blk',
  [SyntaxKind.IfStatement]: 'if',
  [SyntaxKind.SwitchStatement]: 'sw',
  [SyntaxKind.CaseBlock]: 'cb',
  [SyntaxKind.CaseClause]: 'case',
  [SyntaxKind.DefaultClause]: 'dflt',
  [SyntaxKind.ReturnStatement]: 'ret',
  [SyntaxKind.CallExpression]: 'call',
  [SyntaxKind.PrefixUnaryExpression]: 'not',
  [SyntaxKind.ParenthesizedExpression]: 'par',
  [SyntaxKind.BinaryExpression]: 'bin',
  [SyntaxKind.ConditionalExpression]: 'cond',
  [SyntaxKind.ExpressionStatement]: 'expr',
  [SyntaxKind.PropertyAccessExpression]: 'prop',
  [SyntaxKind.Identifier]: 'id',
}

/**
 * Where `node` sits inside `fn`, as a path like `blk0/if2/call0`. Each step is
 * the node's kind and its index among same-kind siblings. Line numbers are left
 * out, so edits elsewhere in the file don't change it.
 */
export function structuralPath(node: Node, fn: FunctionLike): string {
  const segments: string[] = []
  let current: Node | undefined = node
  while (current && current !== fn) {
    const parent: Node | undefined = current.getParent()
    if (!parent) break
    const kind = current.getKind()
    const index = parent.forEachChildAsArray().filter((c) => c.getKind() === kind).indexOf(current)
    segments.push(`${KIND_SHORT[kind] ?? current.getKindName().toLowerCase()}${Math.max(index, 0)}`)
    current = parent
  }
  return segments.reverse().join('/')
}


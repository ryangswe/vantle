import { z } from 'zod'

/** Where a decision's data comes from. Drives the chart legend. */
export const Category = z.enum(['pref', 'state', 'input', 'external'])
export type Category = z.infer<typeof Category>

export const SourceRef = z.object({
  /** Path relative to the project root (the folder holding tsconfig.json). */
  file: z.string(),
  line: z.number().int(),
  /** Folder of `file`, so a structure map can link to this node later. */
  module: z.string(),
  /** Function the node lives in. */
  symbol: z.string(),
})
export type SourceRef = z.infer<typeof SourceRef>

export const CallRef = z.object({
  callee: z.string(),
  /** Repo-relative file of the callee, or null when it couldn't be resolved. */
  file: z.string().nullable(),
  external: z.boolean(),
})
export type CallRef = z.infer<typeof CallRef>

/** Exact position of an expression in a file, so verify can instrument it. Offsets are characters. */
export const Span = z.object({
  file: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  /** The expression's source text, so it can be found again after the file changes. */
  text: z.string().optional(),
  /** The function the expression is in, so relocating it never moves it into another one. */
  fn: z.string().optional(),
  /** The charted function (`file#name`, as in `scope`) the expression belongs to, for tying what it records to a call. */
  owner: z.string().optional(),
  /** For an inlined call: the charted function it calls (`file#name`). */
  callee: z.string().optional(),
  /** For an inlined call: where its last argument is, relative to `start`, so verify can mark the call after its arguments run. */
  lastArg: z.tuple([z.number().int(), z.number().int()]).optional(),
  /** Which copy of `text` this is, when its function has `of` copies of it as a whole expression. */
  nth: z.number().int().optional(),
  of: z.number().int().optional(),
})
export type Span = z.infer<typeof Span>

const NodeBase = z.object({
  id: z.string(),
  /** The condition or value as written in code, in terms of the entry function's parameters. */
  rawLabel: z.string(),
  source: SourceRef,
})

export const DecisionNode = NodeBase.extend({
  kind: z.literal('decision'),
  /** `boolean` has yes/no edges; `switch` has one edge per case. */
  branch: z.enum(['boolean', 'switch']),
  /** Set when the box is inside a loop: the loop's header. The check applies to each item. */
  loop: z.string().optional(),
  categoryHint: Category,
  calls: z.array(CallRef),
  /** Where the tested expression is. More than one after boxes are merged. */
  spans: z.array(Span).optional(),
  /**
   * Set when this box's code can give a different answer from another box with
   * the same code: a call like `next()` or `Date.now()`, or a value that changed
   * in between. Path checks then treat the two as separate questions.
   */
  identity: z.string().optional(),
  /**
   * The inlined calls this box sits inside, outermost first: one list per way
   * the chart reaches it (a helper reused at two call sites has two). Empty
   * for a box in the entry function. Verify takes the box's answer only from
   * the run of the helper made at those calls.
   */
  via: z.array(z.array(Span)).optional(),
})

export const OutcomeNode = NodeBase.extend({
  kind: z.literal('outcome'),
  /** The returned value as code text (`true`, `false`, `'skip'`), or `throw ...`. */
  value: z.string(),
  /** Returned expressions that produce this outcome, when it isn't a plain true/false. */
  spans: z.array(Span).optional(),
})

/** A statement Vantle doesn't look inside yet, such as a loop. Has one `next` edge. */
export const OpaqueNode = NodeBase.extend({
  kind: z.literal('opaque'),
})

/**
 * A step that sets values rather than checking anything, such as "look up the
 * sticky bucket". Vantle adds one where two branches set variables differently
 * and later checks read them, so those checks can be drawn once. Has one `next` edge.
 */
export const ActionNode = NodeBase.extend({
  kind: z.literal('action'),
  /** What this branch set, as code: `foundStickyBucket = false`. */
  assigns: z.array(z.object({ variable: z.string(), value: z.string() })),
})
export type ActionNode = z.infer<typeof ActionNode>

export const FlowNode = z.discriminatedUnion('kind', [DecisionNode, OutcomeNode, OpaqueNode, ActionNode])
export type FlowNode = z.infer<typeof FlowNode>
export type DecisionNode = z.infer<typeof DecisionNode>
export type OutcomeNode = z.infer<typeof OutcomeNode>

export const FlowEdge = z.object({
  from: z.string(),
  to: z.string(),
  /** `yes`/`no` for boolean decisions, the case value or `default`/`other` for switches, `next` for opaque nodes. */
  label: z.string(),
  /** Switch cases written as a name (`Status.Active`): the value it stands for, as JSON. */
  value: z.string().optional(),
})
export type FlowEdge = z.infer<typeof FlowEdge>

/**
 * verified: a test drove the real code through exactly this route to this outcome.
 * failed: a test drove the code along this path, and the code left it or ended differently.
 * untestable: the test writer couldn't build a test, and gave a reason (often
 *   that the path's answers contradict each other). A claim, not a finding.
 * unverified: no working test yet.
 */
export const PathStatus = z.enum(['verified', 'failed', 'untestable', 'unverified'])
export type PathStatus = z.infer<typeof PathStatus>

/** Reads statuses saved under their old names. */
const renamed = (names: Record<string, string>) => (v: unknown) => (typeof v === 'string' && v in names ? names[v] : v)
const OLD_PATH_STATUS = { impossible: 'untestable' }
const SavedPathStatus = z.preprocess(renamed(OLD_PATH_STATUS), PathStatus)

export const FlowPath = z.object({
  id: z.string(),
  steps: z.array(z.object({ node: z.string(), edge: z.string() })),
  outcome: z.string(),
  status: SavedPathStatus,
  /** Stable hash of the steps, so saved tests can be matched to paths. */
  signature: z.string().optional(),
  /** Test file, relative to the project root. */
  test: z.string().optional(),
  /** Why a path failed, can't happen, or has no working test. */
  note: z.string().optional(),
})

/**
 * A place in the charted code that no path test ran, and what Vantle found out about it.
 * missing: a test reached it and the code left the chart, so the chart is missing a branch.
 * untested: no test has reached it yet.
 * untestable: the test writer couldn't build a test to reach it, and gave a reason
 *   (often that it's dead code). A claim, not a finding.
 */
export const GapStatus = z.enum(['missing', 'untested', 'untestable'])
export type GapStatus = z.infer<typeof GapStatus>

export const Gap = z.object({
  id: z.string(),
  status: z.preprocess(renamed({ unreachable: 'untestable' }), GapStatus),
  /** `exit` is a return or throw; `branch` sets a variable read later or leaves a loop; `catch` is a catch block. */
  kind: z.enum(['exit', 'branch', 'catch']),
  file: z.string(),
  line: z.number().int(),
  /** Function the code is in. */
  symbol: z.string(),
  code: z.string(),
  /** Test written to reach it, relative to the project root. */
  test: z.string().optional(),
  note: z.string().optional(),
})
export type Gap = z.infer<typeof Gap>

/** Whether tests ran all the code the chart describes. */
export const Completeness = z.object({
  /** Returns, throws, catch blocks and branches that change what happens next. */
  places: z.number().int(),
  /** Places a path test ran. */
  reachedByPaths: z.number().int(),
  /** Places reached by a test written for them, where the code still followed the chart. */
  reachedOnChart: z.number().int(),
  gaps: z.array(Gap),
})
export type Completeness = z.infer<typeof Completeness>

/** What one kind of test writing cost in a run. */
export const PhaseSpend = z.object({
  requests: z.number().int(),
  tests: z.number().int(),
  /** All input tokens, including cached ones. */
  inputTokens: z.number().int(),
  /** Input tokens read from the prompt cache, billed at a small fraction of the input price. */
  cachedTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
})
export type PhaseSpend = z.infer<typeof PhaseSpend>

/** Test writing by purpose: new path tests, repairs of broken ones, and tests for code no path test ran. */
export const Spend = z.object({ paths: PhaseSpend, repairs: PhaseSpend, gaps: PhaseSpend })
export type Spend = z.infer<typeof Spend>

export const Verification = z.object({
  verifiedAt: z.string(),
  /** Arrows on at least one verified path, out of all arrows in the chart. */
  arrowsVerified: z.number().int(),
  arrowsTotal: z.number().int(),
  counts: z.preprocess(
    (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, n]) => [renamed(OLD_PATH_STATUS)(k), n])) : v),
    z.record(PathStatus, z.number().int()),
  ),
  /** True when the code changed after this chart was extracted. */
  codeChanged: z.boolean(),
  /** True when some boxes' code can't be found any more, so the chart needs regenerating. */
  outOfDate: z.boolean().optional(),
  generatedTests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  completeness: Completeness.optional(),
  spend: Spend.optional(),
})
export type Verification = z.infer<typeof Verification>
export type FlowPath = z.infer<typeof FlowPath>

/**
 * Code that affects what the function does but isn't drawn:
 * effect: a branch whose only effect is a change the chart can't show, such as setting a property or calling a method;
 * callback: checks inside a callback, such as `items.some(i => ...)`, shown as one box;
 * catch: a `catch` block, which isn't followed.
 */
export const NotCharted = z.object({
  kind: z.enum(['effect', 'callback', 'catch']),
  file: z.string(),
  line: z.number().int(),
  symbol: z.string(),
  code: z.string(),
  note: z.string(),
})
export type NotCharted = z.infer<typeof NotCharted>

export const RawFlow = z.object({
  schemaVersion: z.literal(0),
  flow: z.object({
    /** `<repo-relative file>#<function name>` */
    id: z.string(),
    slug: z.string(),
    question: z.string(),
    entry: SourceRef,
    returnsBoolean: z.boolean(),
    generatedAt: z.string(),
    /** Hash of every source file the extractor read. */
    sourceHash: z.string(),
    /** The options it was extracted with, so checking for code changes extracts the same way. */
    extractOptions: z.object({ depth: z.number().int(), maxInline: z.number().int().optional(), maxDuplicates: z.number().int().optional(), maxBoxes: z.number().int().optional() }).optional(),
  }),
  root: z.string(),
  nodes: z.array(FlowNode),
  edges: z.array(FlowEdge),
  paths: z.array(FlowPath),
  /** Total number of paths, counted up to 100,000. `paths` holds at most --max-paths of them. */
  pathCount: z.number().int(),
  /** True when `paths` stopped at --max-paths. */
  pathsTruncated: z.boolean(),
  warnings: z.array(z.string()),
  /**
   * Functions whose code the chart describes: the entry function and every helper
   * drawn inline. Verify checks that tests reached all of their code.
   */
  scope: z.array(z.object({ file: z.string(), name: z.string() })).optional(),
  /** Code the chart can't show, listed so it isn't silently missing. */
  notCharted: z.array(NotCharted).optional(),
  run: z.object({ durationMs: z.number() }),
  verification: Verification.optional(),
})
export type RawFlow = z.infer<typeof RawFlow>

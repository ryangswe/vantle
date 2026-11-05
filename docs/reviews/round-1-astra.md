# Independent review of Vantle at d0084c0

**Verdict:** useful foundations for an explanatory tool, but the current `verified`, `impossible`, and completeness signals are not strong enough to support the stated proof claim. Several ordinary inputs produce false verification; generated tests can also obtain verification without calling the code at all. I would block shipping the current trust claim until findings 1–4 are addressed.

I read the extraction, graph/constraint, labeling, instrumentation, route checking, completeness, test-context and CLI implementations, then checked the spec and GrowthBook write-up against them. I ran `npm ci && npm test` on Node **24.19.0**: **75 tests passed in 5 files**, in 22.32 seconds. Additional repros use real Vitest subprocesses and a fake test writer, with no model/API calls. The existing source was not patched. Line references below refer to the supplied repository, not my reproduction scripts.

“Blocker” below means a blocker for the advertised verification guarantee. It does not mean the tool cannot be useful with a narrower claim. Findings marked reproduced distinguish an actual pipeline run from a direct validator/extractor check.

## Ranked findings

### 1. Blocker — A passing empty test verifies a path; an existing trace bypasses test-validity checks

**Location:** `src/verify/verify.ts:228–249`, especially 235–247; `src/verify/run.ts:257–266`.

**Failure scenario:** Extract `f(x) { if (x) return 'yes'; return 'no' }`. Have the writer emit `it('path', () => {})` for each requested path. Vantle reports **2 verified, 2/2 arrows verified**, although neither test imports or calls `f`. Completeness still shows two untested returns, so this particular repro is a false path signal, not a clean completeness result.

There is a second bypass in the same acceptance boundary: write two tests in each file, one that calls `run(() => f(input))` and one empty test. `runTests` rejects multiple tests, but `apply` ignores that rejection whenever a trace exists. This reports **2 verified and no completeness gaps**. A trace similarly takes precedence over test errors rather than being gated by a valid completed test run.

**Evidence:** Reproduced end to end: `empty-test` and `two-tests` in the appended script.

**Confidence:** High.

**Suggested fix:** Remove the untraced legacy success fallback, or expose it as a separate explicitly weaker status. Require one completed test, a valid trace, exactly one actual entry-function invocation, and a complete outcome before granting verification. Counting calls to `run` is not counting entry-function calls. Treat generated tests as untrusted drivers: they currently run in the same process as writable trace globals and can write the trace JSON themselves. A structured fixture/input contract plus a harness-owned invocation is a substantially stronger boundary than arbitrary test code plus prompt instructions.

### 2. Blocker — A route can combine a decision from one helper invocation with the return from another

**Location:** `src/verify/route.ts:143–150,252–257`; probe deduplication at 44–51; `src/verify/run.ts:22–32`.

**Failure scenario:**

```ts
function h(x: boolean) {
  let result;
  if (x) result = 'yes'; else result = 'no';
  return { value: result };
}
// @vantle: "Which?"
export function f(x: boolean) {
  h(true);
  return h(x);
}
```

Test every requested path with `run(() => f(false))`. The chart inlines the returned call, but probes also fire inside the earlier ignored call. The walker consumes `x=true` from `h(true)` and the last return probe from `h(false)`. Both chart outcomes share the same physical return expression.

Vantle verifies the **yes / `{value:'yes'}` path**, although the invocation producing the result took **no** and returned `{value:'no'}`. The no path remains unverified. Completeness reports **4/4 places reached and no gaps** because the two calls collectively hit them.

**Evidence:** Reproduced end to end, `helper-invocation-mix`.

**Confidence:** High.

**Suggested fix:** Record entry, exit, invocation ID and caller/call-site identity, and match an ordered execution tree. Associate each return with its own invocation. Matching a subsequence of global probe IDs cannot establish an exact route, especially with repeated helpers, recursion, loops or concurrent async work. Preserve call-site identity when merging presentation nodes.

### 3. Blocker — Missing outcome instrumentation silently becomes verified

**Location:** `src/verify/route.ts:38–42,197,220,253–256`.

**Failure scenario:** Generate a chart from:

```ts
export function f(x: boolean) {
  if (x) return {ok:true};
  return {ok:false};
}
```

Change the first return expression to `{ok:'different'}` without regenerating the chart. Verify using real calls for both values of `x`, with `codeChanged:true`. The original object expression no longer relocates, but missing returns are not added to `table.missing`. `checkOutcome` sees no return probes and returns `verified`.

Observed: **2 verified, no failures, 2/2 completeness targets reached, no gaps**. The old object outcome remains displayed while the actual object changed. The code-changed flag does not prevent success.

The same fail-open policy exists for a decision without spans: the walker can stop immediately and still return `verified`, or `holds` during completeness. Removing decision spans and calling `run(() => 'not even f')` reproduced that branch of the behavior; this latter case deliberately uses a degraded chart rather than claiming normal extraction emits it.

**Evidence:** Reproduced end to end, `missing-return-probe` and `missing-span`.

**Confidence:** High.

**Suggested fix:** Missing expected probes must fail closed as stale/unsupported/unverified. Validate chart instrumentation coverage before running tests. Separate “route prefix observed,” “return site observed,” and “outcome value checked”; none should be silently promoted to the strongest status.

### 4. Blocker — Extraction and completeness share a blind spot for property mutations and response side effects

**Location:** `src/extract/extract.ts:267–270,460–461`; `src/verify/coverage.ts:115–129,155–173`.

**Failure scenario:**

```ts
// @vantle: "What response?"
export function f(stop: boolean, flag: boolean, res: {body: string}) {
  if (stop) return 'stop';
  if (flag) res.body = 'approved'; else res.body = 'denied';
  return res;
}
```

Only the `stop` decision survives extraction. Property assignment does not update a tracked local value, so both `flag` arms appear to have the same continuation and disappear. Completeness's assignment detection accepts identifier targets only; `res.body` is not counted. The final object is checked by return location, not its body.

Tests of `stop=true/false`, always with `flag=false`, produce **2 verified, all arrows verified, no gaps**. The approval branch is absent and never tested. There is no extraction warning for it. The analogous issue applies to `res.send(...)`, writes through `this`, persistence calls and other effects whose significance is not captured by local identifier assignments.

**Evidence:** Reproduced end to end, `side-effects`; extension to response calls follows directly from the expression-statement and coverage filters.

**Confidence:** High.

**Suggested fix:** Either explicitly limit support to return-value decision logic and mark effectful branches as unsupported, or preserve effectful branch/action nodes and instrument them. Use an independent conservative branch inventory for completeness; do not let it share the extractor's definition of what is worth omitting. Finding no gaps among selected targets does not establish that the target inventory is complete.

### 5. High — `await` decisions are probed before the await resolves

**Location:** `src/extract/extract.ts:460–462,836–841`; `src/verify/run.ts:108–110,156–158`.

**Failure scenario:**

```ts
async function check() { return false; }
// @vantle: "Allowed?"
export async function f() {
  let result;
  if (await check()) result = 'yes'; else result = 'no';
  return {value: result};
}
```

`unwrap` removes `await` before selecting the probe span. Instrumentation produces the equivalent of `await probe(check())`. The probe records the Promise, which is truthy, although the condition evaluates to false after awaiting it.

Observed: the **yes outcome is verified** while the actual result is `{value:'no'}`. The no path is unverified. The shared return expression makes the wrong answer pass the nonliteral-outcome check. In a version returning string literals, the result check catches the discrepancy, but Vantle incorrectly reports a chart failure and cannot verify the real no route.

**Evidence:** Reproduced end to end, `await-boolean` and `await-false-verified`.

**Confidence:** High.

**Suggested fix:** Separate expression normalization for display/resolution from runtime evaluation boundaries. Probe the resolved value: `probe(await check())`. Add instrumented/uninstrumented differential tests for async conditions, rejection, short-circuiting and `return await`, preserving evaluation order and evaluation count.

### 6. High — Labels can invert a decision and still pass validation

**Location:** `src/label/validate.ts:92–110,210–215`; `src/graph/paths.ts:23–32`; `src/label/label.ts:65–95`.

**Failure scenario:** For `if (x)`, submit a structurally valid label **“Is x false?”**, with valid IDs, category `input`, nonempty rationale and unchanged outcome labels. `validateLabels` returns `ok:true`. The yes arrow still corresponds to `x=true`, so the reader follows the opposite meaning from the code.

The behavioral comparison copies `rawLabel` into the graph's `test`; it never interprets the new prose. Route verification also checks the underlying spans rather than label meaning. The reference-label judge is not part of normal `labelFlow` acceptance.

**Evidence:** Reproduced by directly calling `validateLabels` with the inverted label. The absence of semantic checking in later route verification is reasoned from the implementation.

**Confidence:** High.

**Suggested fix:** Name this signal “structure validated.” Keep semantic review as a separate status and expose the exact predicate with yes/no meaning. A separate semantic judge can reduce mistakes, but should not be presented as a proof. For stronger guarantees, restrict labels to checked templates or require human approval for semantic assertions, including outcome and switch-case prose.

### 7. High — The writer can declare reachable paths impossible, and those claims persist

**Location:** `src/verify/verify.ts:168–174,212–219,460,474–477`; `src/verify/select.ts:77–88`.

**Failure scenario:** For the simple `f(x)` yes/no function, have the writer answer every path and reach request with `kind:'impossible'`, `reason:'Because I say so'`, `conflict:[]`. Vantle reports **2 impossible paths**, and both plainly reachable returns as **unreachable / “can't run.”** Neither declaration needs a demonstrated contradiction.

Nonempty conflicts are checked for recognizable node/edge names, not for logical validity or even membership in the particular requested path. They can suppress additional candidates. Saved impossible/unreachable results are reused unless regenerated; `codeChanged` is informational and does not invalidate them.

**Evidence:** Reproduced acceptance of the arbitrary claims, `unjustified-impossible`. Persistence and wider pruning are reasoned from the cited branches.

**Confidence:** High.

**Suggested fix:** Use “writer could not construct a test” by default. Reserve impossible/unreachable for checked proof obligations or explicitly human-accepted assumptions. Validate conflicts against their requested path, do not let an unproven claim prune unrelated exploration, and invalidate assumptions on relevant source changes.

### 8. High — Any thrown exception satisfies every throw outcome

**Location:** `src/verify/route.ts:241–242`; `src/extract/extract.ts:234–236`.

**Failure scenario:** Extract `if (x) throw new Error('expected'); return 'ok'`. Change only the throw to `new Error('different')`, and verify with `f(true)` and `f(false)`. The chart still says `throw new Error('expected')`; Vantle reports **2 verified and no completeness gaps**.

It checks only `result.threw`. It does not require the intended throw statement to fire or match the error's identity/type/value. Consequently an earlier dependency failure after the last decision can also stand in for the charted throw. That latter consequence is reasoned, not the demonstrated output of the edit experiment.

**Evidence:** Reproduced end to end, `throw-identity`.

**Confidence:** High.

**Suggested fix:** Give throw sites the same invocation-aware terminal identity as returns, and require the recorded throw to escape the relevant entry invocation. Preserve structured error data if labels assert error type/reason. Otherwise display only the weaker statement that an exception occurred. A reach marker before a throw is not enough: evaluating the throw expression can itself fail.

### 9. High — Text relocation can attach a probe inside a keyword

**Location:** `src/verify/route.ts:75–84`; `src/verify/run.ts:156–167`.

**Failure scenario:** Start with the following source, extract it, then expand the first function to throw an error:

```ts
function dep(){}
// @vantle: "Why throws?"
export function f(x:boolean){if(x){dep();throw new Error('expected')}return 'ok'}
```

Changing `function dep(){}` to `function dep(){throw new TypeError('unrelated')}` shifts the decision's original offset. Relocation searches the whole file for the nearest substring `x`. In this reproduction it selects the **x in `export`**, not the condition. The generated source begins `eglobalThis.__vantleProbe(...x...)port ...`, and Vitest fails to parse it.

This is not only duplicate-expression ambiguity: matches need not be AST nodes or even whole identifiers. Comments, strings, parameter names and unrelated functions can all win. Failure is attributed to the generated test although instrumentation broke valid code.

**Evidence:** Reproduced end to end in `wrong-throw-origin`; direct inspection of the relocated probe confirmed offset 76 inside `export`. That case name describes the original investigation, not its observed result: the actual failure was relocation.

**Confidence:** High.

**Suggested fix:** Reparse current source and resolve a candidate by function, node kind, structural identity and surrounding context. Require a unique compatible candidate; otherwise report stale chart. Never insert probes at arbitrary substring matches. Validate all spans and transformed syntax before asking the writer to repair tests.

### 10. High — Path enumeration assumes identical expression text has a stable value

**Location:** `src/graph/paths.ts:57–81,175–181`.

**Failure scenario:**

```ts
// @vantle: "What?"
export function f(next: () => boolean) {
  if (next()) {
    if (next()) return 'TT';
    return 'TF';
  }
  return 'F';
}
```

The extractor retains three outcomes, but `flow.paths` contains only **yes/yes → TT** and **no → F**. A callback that returns true then false reaches TF, yet that feasible path is pruned as contradictory because both evaluations use the constraint key `next()`.

The same assumption is unsafe for getters, mutable state, distinct `this` receivers, time/randomness and side-effecting calls. Separately, the constraint parser treats `==` and `===` identically, so `x == 1` followed by `x === '1'` can incorrectly eliminate a path reachable with the string `'1'`.

**Evidence:** Reproduced the callback case by extraction/enumeration, `stateful-conditions`. Loose-equality and mutable-receiver variants are reasoned from `edgeConstraint`.

**Confidence:** High.

**Suggested fix:** Use evaluation identities and state versions, not normalized text, for constraints. Unify only expressions proven pure and stable between evaluations. Keep loose equality conservative unless coercion is modeled. Prefer redundant candidate tests to deleting feasible paths. Completeness may later reach TF, but that does not repair its missing path/status or make the path count correct.

### 11. High — Completeness counts reached targets as on-chart even when their traces were never accepted

**Location:** `src/verify/verify.ts:233–235,440–445`; `src/render/mermaid.ts:126–133`.

**Failure scenario:** Every available path trace enters `traces` before route checking. Completeness then unions all reach events without considering whether the path was verified, failed, missed, or broken, and skips further checking for those targets. The summary describes them as having “stayed on the chart.”

In the repeated-helper reproduction, an unverified no-path test still contributes coverage, and the earlier ignored invocation reaches the other assignment arm. The result is **4/4 places and no gaps**, despite the absence of a valid match for the result-producing no route. In the async reproduction, the literal-outcome version reports a failed path but still counts its reached return toward the on-chart summary.

**Evidence:** Reproduced those inconsistent coverage results; the unconditional union is directly visible in the cited code. This is distinct from finding 4: here the target exists, but its evidence is accepted too loosely.

**Confidence:** High.

**Suggested fix:** Track “executed” separately from “executed in a validated entry trace and represented by the chart.” Run `checkReach` or an equivalent scoped check on path traces as well as specially generated reach tests. Keep discovered gaps even when another execution hits the same source location successfully.

### 12. High — The generated runner drops essential project runtime configuration

**Location:** `src/verify/run.ts:171–188,232–239`; `src/project.ts:21–31`.

**Failure scenario:** Configure `paths: {'@/*':['src/*']}` with `baseUrl:'.'`, and import `@/dep` from the annotated function's module. Extraction resolves the project. The generated tests fail with **“Cannot find package '@/dep' imported from …/src/main.ts”**. Both paths remain unverified after repair. Changing input setup cannot fix the missing resolver.

The generated config includes only Vantle's plugin/setup, and runs from `.vantle/tests`. It does not merge the target's Vite/Vitest aliases, plugins, setup files, environment or workspace projects. The child inherits process environment variables, so the problem is not that all environment variables vanish; project-specific loading/setup and relative working-directory assumptions are what are lost. A module opening connections or reading configuration at import can fail before a generated fixture gets a chance to run.

**Evidence:** Alias failure reproduced end to end, `aliases`. Setup/environment/import-side-effect consequences are reasoned from the runner configuration; I did not reproduce every listed project system.

**Confidence:** High for the reproduced failure and missing configuration; project-specific effects vary.

**Suggested fix:** Add a project runner adapter with explicit configuration selection/merging, tsconfig-path resolution, setup/environment support, and package-root handling. Preflight importability once before paying for per-path repairs. Allow users to provide a fixture adapter for dependency injection and import-time initialization. Test CJS/ESM, `.mts`/`.cts`, NodeNext, monorepo package roots and `.js` specifiers separately; this finding is not evidence that every `.js` specifier fails.

### 13. Medium — The test writer can receive dependencies but not the function it must test

**Location:** `src/verify/context.ts:27–45,53–64`.

**Failure scenario:** The entry imports a dependency containing approximately 59,000 characters. The entry contains approximately 2,000 characters. The dependency-first traversal consumes the 60,000-character budget and skips the entry. Directly calling `testContext` produced:

```json
{"truncated":true,"files":["src/dep.ts"],"entry":"src/main.ts"}
```

The writer still gets path descriptions and import metadata, but not the entry implementation needed to understand construction, setup and reachable inputs. A single entry file larger than the budget is also skipped wholesale. This is particularly problematic for large SDK files and class/DI setup, where repeated model repairs cannot recover omitted context reliably.

**Evidence:** Reproduced directly with `testContext`; no claim that a live model necessarily fails every such request.

**Confidence:** High.

**Suggested fix:** Reserve space for the annotated function, its containing class/constructor, relevant types and immediate setup first. Slice by symbols rather than accepting or dropping entire files. Let the writer request focused missing context; prominently distinguish context insufficiency from a faulty test or an impossible path.

## Design and change risk

The useful core is deterministic extraction plus executions that try to falsify the chart. The problematic step is elevating finite observations and heuristics into a claim that the entire chart is proven complete. Even after the implementation bugs are fixed, one test per arrow does not establish equivalence for all inputs, all loop iterations, or every combination of branches. Return-location agreement also does not establish the meaning of an arbitrary object outcome or its prose label.

A defensible contract would expose separate facts: structural validation passed; this specific execution matched a route; this return/throw site fired; these explicitly enumerated source obligations were exercised; these constructs and effects remain unsupported; these labels/assumptions need semantic review. “Impossible” needs a different evidentiary standard from “could not generate a test.”

The hardest components to change safely are:

- **Execution identity and abstraction.** `extract.ts` substitutes values, inlines helpers, shares nodes, widens joins and simplifies loops; `route.ts` tries to reconstruct executions from the resulting graph. Presentation sharing needs to be separated from source/call/invocation identity. Finding 2 is a symptom of that missing separation.
- **The extractor's partial evaluator.** Continuations, environment pruning, memoization and widening are tightly coupled. Default/rest parameters, parameter mutation, closure mutation, receiver identity, catch/finally and dynamic dispatch need explicit semantics or explicit unsupported status. A method's receiver is not included in `tryInline`'s reuse key at line 520. Do not assume class/DI behavior is covered because a method body resolves statically.
- **Instrumentation generated as strings.** Helpers, setup and the Vite plugin live inside `run.ts` string constants. They lack the same direct type checking and unit-test ergonomics as ordinary modules. Factor them into testable modules, validate span-to-AST correspondence, and add differential tests that compare original and instrumented behavior.
- **Completeness independence.** A second selective AST walk is useful, but it is not independent enough when it excludes the same effects as extraction. Conservative source obligations should be recorded before abstraction and remain visible even if the renderer suppresses a box.
- **Scaling.** Path selection enumerates up to 100,000 paths before choosing at most 200, and `compareBehavior` performs a nested path-pair comparison. I did not benchmark a large project here, but this is an evident scaling limit. Report truncation honestly and move toward targeted edge search or symbolic summaries before claiming support for substantially larger functions.

For the requested portability matrix: re-export traversal is present in `testContext`, which is good; static aliases can resolve during extraction yet fail at runtime; methods require actual receiver construction; unresolved injected/dynamic callees cannot safely be treated as exhaustively expanded; response-oriented handlers hit finding 4. NodeNext/CJS and reference-only monorepo roots need dedicated integration fixtures. I am not claiming those modes were all empirically tested in this review.

## What looks solid

- The modules have useful boundaries: extraction, label validation, path selection, running tests, route checks and completeness can be exercised independently. The fake-writer API made these repros straightforward.
- Forward walking with explicit continuations and declaration-keyed environments is a reasonable foundation for a supported subset. It is substantially more inspectable than asking an LLM to invent the graph.
- Label validation does real structural work: missing/invented IDs, duplicate assignments, invalid merges and inconsistent labels are checked. Its value remains once semantic claims are separated from structural ones.
- Instrumentation normally returns the original expression value, and reach probes account for single-statement arms by wrapping them. Those are good details; the problems are evaluation boundaries, stale spans and execution identity.
- Saved tests, trace cleanup before runs, deterministic path signatures and bounded repairs are sensible practical choices. The existing tests cover meaningful drift and missing-branch cases, not just superficial output snapshots.

## Reproduction instructions

Use a disposable checkout of the supplied d0084c0 repository. After `npm ci`, save Appendix A as `review-repro.ts` at the repository root and run:

```sh
node --import tsx review-repro.ts
```

It writes temporary TypeScript projects, runs the real verifier with deterministic writers, and prints/writes its observations. Appendix B is the corresponding second script, saved as `review-extra.ts`. These are diagnostic scripts: success means they ran, not that Vantle's reported results are sound. They do not assert that the bugs are desirable. The synthetic missing-span case intentionally alters the in-memory chart; stale-code cases intentionally edit only temporary project files. No API key is needed.

Appendix B's `wrong-throw-origin` case is retained because it exposed finding 9. Its observed outcome is an instrumentation parse error, not a reproduced wrong-throw-origin success. The direct `testContext` repro in finding 13 can be recreated with a 59,000-character comment in an imported dependency and a 2,000-character comment in the entry module.


## Appendix A — Main reproduction script

```ts
import {tempProject, extract, editFile} from './test/helpers.js'
import {loadProject} from './src/project.js'
import {verifyFlow} from './src/verify/verify.js'
import {validateLabels, shortIds} from './src/label/validate.js'
import {probeTable, checkRoute, checkReach} from './src/verify/route.js'
import {selectPaths} from './src/verify/select.js'
import type {TestWriter, TestRequest, PathSpec} from './src/verify/writer.js'
import {writeFileSync} from 'node:fs'
import path from 'node:path'
const results:any[]=[]
async function run(name:string, source:string, body:(p:any,r:TestRequest)=>string, options:any={}, mutate?:(f:any,d:string)=>void, extra?: (d:string)=>void) {
 const dir=tempProject({'main.ts':source}); extra?.(dir); const flow=extract(dir); mutate?.(flow,dir)
 const writer:TestWriter=async r=>({answers:[...r.paths,...r.targets].map(p=>({id:p.id,kind:'test' as const,code:body(p,r)})),inputTokens:0,outputTokens:0,costUsd:0})
 const verified=await verifyFlow(loadProject(dir),flow,writer,options)
 const result={name,dir,nodes:flow.nodes.map(n=>({id:n.id,kind:n.kind,raw:n.rawLabel})),warnings:flow.warnings,paths:verified.paths,verification:verified.verification}
 results.push(result); console.log(JSON.stringify(result)); return {flow,dir,verified}
}
const branch=`// @vantle: "Allowed?"\nexport function f(x:boolean){if(x)return 'yes';return 'no'}`
await run('empty-test',branch,p=>`it('${p.id}',()=>{})`)
await run('two-tests',branch,(p,r)=>`import {f} from '${r.context.entry.specifier}'; import {run} from '../vantle'; it('first',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'}))); it('second',()=>{});`)
await run('missing-span',branch,(p,r)=>`import {run} from '../vantle'; it('x',()=>run(()=> 'not even f'));`,{},flow=>{for(const n of flow.nodes) if(n.kind==='decision') n.spans=[]})
await run('helper-invocation-mix',`function h(x:boolean){let result; if(x)result='yes';else result='no';return {value:result}}\n// @vantle: "Which?"\nexport function f(x:boolean){h(true); return h(x)}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(false)));`)
await run('side-effects',`// @vantle: "What response?"\nexport function f(stop:boolean,flag:boolean,res:{body:string}){if(stop)return 'stop';if(flag)res.body='approved';else res.body='denied';return res}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'},false,{body:''})));`)
await run('await-boolean',`async function check(){return false}\n// @vantle: "Allowed?"\nexport async function f(){if(await check())return 'yes';return 'no'}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',async()=>{await run(()=>f())});`)
await run('throw-identity',`// @vantle: "Why throws?"\nexport function f(x:boolean){if(x)throw new Error('expected');return 'ok'}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'})));`,{},(flow,dir)=>editFile(path.join(dir,'src/main.ts'),s=>s.replace("throw new Error('expected')","throw new Error('different')")))
await run('aliases',`import {answer} from '@/dep';\n// @vantle: "Allowed?"\nexport function f(x:boolean){if(x)return answer;return 'no'}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'})));`,{},undefined,dir=>{writeFileSync(path.join(dir,'src/dep.ts'),`export const answer='yes'`);writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',baseUrl:'.',paths:{'@/*':['src/*']}},include:['src']}))})
const d=tempProject({'main.ts':branch});const f=extract(d);const ids=shortIds(f)
const label=validateLabels(f,{boxes:f.nodes.filter(n=>n.kind==='decision').map(n=>({ids:[ids.toShort.get(n.id)!],label:'Is x false?',category:'input' as any,rationale:'Negates x',caseLabels:[]})),outcomes:f.nodes.filter(n=>n.kind==='outcome').map(n=>({id:ids.toShort.get(n.id)!,label:n.rawLabel})),actions:[]})
results.push({name:'inverted-label',ok:label.ok});console.log('inverted-label',label.ok)
const impossible:TestWriter=async r=>({answers:[...r.paths,...r.targets].map(p=>({id:p.id,kind:'impossible',reason:'Because I say so',conflict:[]})),inputTokens:0,outputTokens:0,costUsd:0})
const imp=await verifyFlow(loadProject(d),f,impossible);results.push({name:'unjustified-impossible',paths:imp.paths,verification:imp.verification});console.log('impossible',JSON.stringify(results.at(-1)))
writeFileSync('review-repro-results.json',JSON.stringify(results,null,2))
```


## Appendix B — Additional reproduction script

```ts
import {tempProject, extract, editFile} from './test/helpers.js'
import {loadProject} from './src/project.js'
import {verifyFlow} from './src/verify/verify.js'
import {validateLabels, shortIds} from './src/label/validate.js'
import {probeTable, checkRoute, checkReach} from './src/verify/route.js'
import {selectPaths} from './src/verify/select.js'
import type {TestWriter, TestRequest, PathSpec} from './src/verify/writer.js'
import {writeFileSync} from 'node:fs'
import path from 'node:path'
const results:any[]=[]
async function run(name:string, source:string, body:(p:any,r:TestRequest)=>string, options:any={}, mutate?:(f:any,d:string)=>void, extra?: (d:string)=>void) {
 const dir=tempProject({'main.ts':source}); extra?.(dir); const flow=extract(dir); mutate?.(flow,dir)
 const writer:TestWriter=async r=>({answers:[...r.paths,...r.targets].map(p=>({id:p.id,kind:'test' as const,code:body(p,r)})),inputTokens:0,outputTokens:0,costUsd:0})
 const verified=await verifyFlow(loadProject(dir),flow,writer,options)
 const result={name,dir,nodes:flow.nodes.map(n=>({id:n.id,kind:n.kind,raw:n.rawLabel})),warnings:flow.warnings,paths:verified.paths,verification:verified.verification}
 results.push(result); console.log(JSON.stringify(result)); return {flow,dir,verified}
}
const branch=`// @vantle: "Allowed?"\nexport function f(x:boolean){if(x)return 'yes';return 'no'}`
await run('missing-return-probe',`// @vantle: "Which object?"\nexport function f(x:boolean){if(x)return {ok:true};return {ok:false}}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'})));`,{codeChanged:true},(flow,dir)=>editFile(path.join(dir,'src/main.ts'),s=>s.replace('{ok:true}',"{ok:'different'}")))
await run('await-false-verified',`async function check(){return false}\n// @vantle: "Allowed?"\nexport async function f(){let result; if(await check())result='yes';else result='no';return {value:result}}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',async()=>{await run(()=>f())});`)
await run('wrong-throw-origin',`function dep(){}\n// @vantle: "Why throws?"\nexport function f(x:boolean){if(x){dep();throw new Error('expected')}return 'ok'}`,(p,r)=>`import {f} from '${r.context.entry.specifier}';import {run} from '../vantle';it('x',()=>run(()=>f(${p.steps?.[0]?.answer==='yes'})));`,{codeChanged:true},(flow,dir)=>editFile(path.join(dir,'src/main.ts'),s=>s.replace('function dep(){}',"function dep(){throw new TypeError('unrelated')}")))
const changing=tempProject({'main.ts':`// @vantle: "What?"\nexport function f(next:()=>boolean){if(next()){if(next())return 'TT';return 'TF'}return 'F'}`}); const cf=extract(changing);results.push({name:'stateful-conditions',paths:cf.paths,nodes:cf.nodes});console.log('stateful-conditions',JSON.stringify(results.at(-1)))
const d=tempProject({'main.ts':branch});const f=extract(d);const ids=shortIds(f)
const label=validateLabels(f,{boxes:f.nodes.filter(n=>n.kind==='decision').map(n=>({ids:[ids.toShort.get(n.id)!],label:'Is x false?',category:'input' as any,rationale:'Negates x',caseLabels:[]})),outcomes:f.nodes.filter(n=>n.kind==='outcome').map(n=>({id:ids.toShort.get(n.id)!,label:n.rawLabel})),actions:[]})
results.push({name:'inverted-label',ok:label.ok});console.log('inverted-label',label.ok)
const impossible:TestWriter=async r=>({answers:[...r.paths,...r.targets].map(p=>({id:p.id,kind:'impossible',reason:'Because I say so',conflict:[]})),inputTokens:0,outputTokens:0,costUsd:0})
const imp=await verifyFlow(loadProject(d),f,impossible);results.push({name:'unjustified-impossible',paths:imp.paths,verification:imp.verification});console.log('impossible',JSON.stringify(results.at(-1)))
writeFileSync('review-extra-results.json',JSON.stringify(results,null,2))
```

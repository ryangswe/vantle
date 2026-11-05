# Design: an automatic correctness check for charts

Status: A1 built (see "First results"); A2 and A3 to come

## What it is for

Today the only way to find a wrong chart is an LLM reviewer reading it. That is slow, costs money, and its strictness drifts between rounds. The last two PRs each had real bugs found late by reviewers. Most sat where features interact (identity, labels, widening, inlining, throws).

The next feature, dead arrows, removes arrows. Removing an arrow that some execution can take hides a real path, which is worse than drawing a dead one. So before that work starts, we want a mechanical check that catches charts that are wrong, not just ugly.

**The check:** for many small self-contained marked functions, run the real code on many inputs under verify's instrumentation, and check each run against the chart.

## What it checks

Each run records the code's route with the same probes `verify` uses: boxes, returns, inlined call sites, function entries, and the completeness probes on every `return`, `throw` and `catch`. Every run then gets exactly one verdict.

**Fail:**

1. **Left the chart.**
   - Walking the chart with the code's answers ends at an outcome other than the one the code produced, or the chart's next box never ran.
   - Or the code took an arrow the chart doesn't have. The walk in `route.ts` crashes on that today and must report it instead: `edges.find(...)!` throws on a missing yes or no, and a missing switch case silently falls into `other`.
   - Or a charted `throw` fired when the chart's route doesn't reach it.
2. **Ruled out by the chart's own logic.**
   - Replaying the route through the same step function `enumeratePaths` uses must not hit a contradiction. That function is the edge constraints, `assume`, and the facts step boxes set.
   - When the chart's path list wasn't truncated, the route must also be one of its paths.
   - This catches two boxes merged into one question, and step-box facts that are wrong.
3. **A checked box the walk skipped.** The walk looks ahead for each box's answer, so a box the code evaluated but the route never visits would go unnoticed. That is how a wrongly resolved check could hide. This is **reported, not failed**: a check the extractor settled on one path shares its code, and so its probe, with the box drawn on another path. (`let x = load(); if (a) x = true; if (x) …`: on `a` = yes the check is settled, but the code still evaluates `x`.) The per-arrow baseline below is what guards removed arrows. Boxes inside loops and helper boxes shared by two calls are left out.

**Unjudged** (counted and reported, not a pass):

- a charted loop whose body didn't run exactly once (charts draw loops as one pass);
- a throw from a place the chart lists as not charted;
- a promise as an answer;
- a run that hit its time limit.

An unjudged run that fits none of these is *unexpected*. It's reported, and it doesn't fail CI until we know how often it happens.

**Per arrow, across all runs:** taken, or not taken. A not-taken arrow is a *likely* dead arrow, never a proven one.

## The safety net for dead-arrow work

The baseline records a verdict for every arrow of every corpus chart: **taken**, **triaged dead** (a person confirmed no input can take it, with a reason), or **untested**.

A dead-arrow PR fails the check if it removes an arrow that isn't triaged dead. That includes any arrow some run takes, and also untested ones. This is what stops pruning from hiding a live path. Merely reporting changes to the likely-dead list wouldn't.

Charts whose path list truncates are flagged. Dead-arrow work must not conclude an arrow is dead from a truncated list.

## How runs are made

- **Real instrumentation, unchanged.** `run()` is split into `record(call) → trace` and `run() = record + save`. `record` resets the call counter and keeps its trace in memory, so one test file can await many runs in turn. Verify's behaviour doesn't change.
- **Probe table built as in `verify.ts`:** the probe table, completeness probes, then entry probes. Without entry probes, every box inside a helper would read as skipped.
- **One Vitest process for the whole corpus.**
  - Every case is its own copy of its project, so two flows never instrument the same file.
  - Their probe tables are merged into one `probes.json`, with ids offset per case.
  - A watchdog kills a hung process and resumes from the next case.
- **Inputs are data,** written as small JSON specs that the test file turns into values. A failing input can therefore be printed, saved as a repro and replayed.

### Stubs follow SPEC's assumptions, not kinder ones

Functions with no body (interface methods, `declare function`, `declare const`) become stubs. They behave as SPEC says code Vantle can't see into might:

- **Same answer for the same question.** A stub returns the same value for the same arguments, compared by a snapshot of their contents at call time. An object passed to any stub gets a new version (SPEC assumes unseen code changes what it's given), so later calls with it can answer differently.
- **Methods known not to change anything** (`forEach`, `then`, `log`) don't bump the version.
- **Consuming and sampling calls** (the extractor's own `VOLATILE_CALL` list, exported rather than copied, plus `new`) get a fresh value on every call.
- **Some runs also let stubs:**
  - change a property of an argument for real;
  - throw, so that `catch` blocks behind unseen calls get reached.

### Input generation (second PR)

- Inputs are generated from the parameter types, plus `this` for methods, using ts-morph:
  - **Literals:** every member of a literal union or enum.
  - **Numbers and strings:** the literals in the charted code and their neighbours.
  - **Optional values:** `undefined` and `null` where the type allows.
  - **Arrays:** empty, one element, or two.
  - **Objects:** built property by property.
  - **Promises:** resolved with a generated value.
  - **Shared objects:** sometimes the same object is passed as two parameters.
  - **Generics, `any`, index signatures and recursive types:** depth is capped, and a case the generator can't handle is skipped with a reason.
- **Classes:** the constructor is tried with generated arguments first, so field initialisers run. The fallback is the prototype, with fields set. Classes the file doesn't export get an `export { … }` appended at the end of the file, which keeps probe offsets intact.
- **Search:** exhaustive up to 4,096 combinations.
  - Above that, inputs that reach a new arrow or probe are kept and varied, with a fixed seed.
  - A case can add hand-written inputs in `inputs.json`.

## The corpus

1. **Repros:** the reviewers' repros and probes from the PR #16 handoff, cleaned up, one folder per case under `test/correctness/corpus/`. Every future bug a reviewer finds gets a case here.
2. **Every function the tests extract.** `extract()` in `test/helpers.ts` writes its files, the function's name and the options to a folder when an environment variable is set. Running the test suite with it set gathers about 150 cases, options included (for example `maxBoxes: 6`). This replaces scanning the test files' text, which misses most of them and loses options.

Real repos from Test A aren't in the corpus. Their functions need databases and services, which is what `verify`'s LLM-written tests are for.

## What it can't catch

- **Loops that run zero or several times.** Charts draw one pass, so those runs aren't judged. A chart wrong only on a later pass (the loop hole below) isn't caught. Judging later passes against the per-item reading SPEC gives loop boxes is follow-up work.
- **Two values merged into one box when they never meet on one run.** No run contradicts that chart. It's unclear about which object it means, not wrong about what happens (PR #16's r2 and r9).

- **A branch no input reaches.** Arrows marked untested show where that's happening.
- **Wrong labels and readability.** Reviewers still judge those, but only on charts that pass this check.
- **Behaviour that depends on real I/O.**

## First results (A1)

**What the corpus holds:** 44 cases.
- The PR #16 reviewer repros and probes (`r*`, `b*`, `h1`, `w1`, `p*`).
- The repros from the core and dead-arrow design review (`c*`, `endpointfor-shape`, `hole-*`).
- Two sanity cases.

Each case has hand-written inputs. A run takes about 15 seconds.

**On the extractor from mid-PR #16, before its identity fixes** (`--extractor` pointed at `36ea161`):
- **Caught:** 5 of the reviewer's 9 repros fail mechanically, each with a ready-to-paste input: r1, r5, r6, r7 and r8.
- **Never in a committed tree:** r3 and r4's charts are the same as today's. Their bugs only existed in the reviewer's working copy.
- **Blind spot:** r2 and r9 differ only in merging two values that never meet on one run (above).

**On today's `main`:**
- **Six real-path holes fail.** Each extracts a chart that rules out a route the code takes, and the check prints the input that takes it:
  - an alias (`hole-alias`);
  - a change through another reference (`hole-other-reference`);
  - an unrelated effect before a repeated lookup (`hole-unrelated-effect`);
  - a truthiness check sharing its key with an equality check on the same value (`hole-truthy-vs-equal`, `hole-truthy-vs-null`);
  - a catch reached through a call inside a helper (`hole-catch-in-helper`);
  - a helper's step box constraining the caller's variable of the same name (`hole-step-assign-name`).
- **The fourth hole isn't seen.** It's on a later loop pass, which isn't judged (above).
- **The dead-arrow cases list their dead arrows** under "no run took", for example all six `target === 'ui'` copies in `endpointfor-shape`.

**A `verify` gap it found (unjudged, not a chart error):**
- A helper call the extractor folds completely gets no call-site probe. An example is `prep('assets', path)`, whose argument is a known literal.
- Its `return` then fires in a run the chart doesn't tie to any call, so `verify` can't credit the outcome.
- Paths that end there stay unverified (`c4a-caller-checked-arg`).

## PRs

- **A0** (private PR #17): CI runs typecheck and the unit tests.
- **A1:** the first working version, on the repro corpus with hand-written inputs:
  - the `record()` split;
  - the walk reporting a missing arrow;
  - checks 1–3 and the unjudged categories;
  - the script, `npx tsx experiments/correctness.ts`.
- **A2:** the input generator and the stub model.
- **A3:**
  - gathering cases through the `extract()` hook;
  - the per-arrow baseline;
  - the CI workflow;
  - a write-up of what the check finds on today's extractor.

Fixes for anything it finds come after, each as a small PR with its corpus case.

Deferred: failing CI on unexpected unjudged runs, `vantle diff` replay, and the Slack fixture.

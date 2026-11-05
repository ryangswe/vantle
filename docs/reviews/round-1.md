# Review round 1

**Reviewed:** commit `d0084c0` (after PR #10), before the field tests on other people's repos.

| Reviewer | Focus |
|---|---|
| **F1** (Fable) | Can verified, impossible or the completeness check be wrong? |
| **F2** (Fable) | Real repos and code health. Also ran extraction on Unleash's Node client, CASL and Flagsmith's Node client. |
| **A** (ChatGPT Astra, outside reviewer) | All of the above, from a written brief ([its report](./round-1-astra.md)). Ran `npm test` (75 passed) and 13 end-to-end repros with fake test writers. |

Each finding is marked **repro** (a reviewer ran it) or **read** (argued from the code). ✔ means I reproduced it myself during triage. Severity is how much it hurts the promise "a verified chart is true to the code".

## A. The chart can be silently wrong

| # | Finding | Severity | Evidence | From |
|---|---|---|---|---|
| A1 | **The memo cache ignores a helper's arguments.** A helper called with a value that depends on an earlier branch is walked twice, but the second walk reuses the first's boxes, and the earlier branch disappears. In the repro, the chart has only `b`, and for `a=false, b=false` it says false where the code says true. | blocker | repro ✔ | F1, F2 |
| A2 | **Changes through properties and methods are invisible.** In `const reasons = []; if (user.banned) reasons.push('banned'); … if (reasons.length > 0) return false`, both real checks vanish, and the only box left is `([]).length > 0`. The same happens with `opts.elevated = true`, and with `res.body = 'approved'` or `res.send(...)` in request handlers. The completeness check finds nothing missing, because it shares the extractor's idea of what matters. | blocker | repro ✔ | F1, A |
| A3 | **Undoing an oversized inline leaves stale cache entries.** A later walk can return a box that was deleted, so arrows point at nothing and paths silently disappear. | high | repro | F2 |
| A4 | **Enum switches.** `case Status.Active:` gets an extra "other" arrow that can't happen, and verify can't match the recorded value to a case, so these paths never verify. | high | repro ✔ | F2 |
| A5 | **Repeated calls are treated as one value.** `if (next()) { if (next()) return 'TT'; return 'TF' }` lists only 2 paths for 3 outcomes: the `'TF'` path is pruned as contradictory and never tested. The same goes for getters, mutable state, time and randomness. `==` and `===` are also treated the same. | high | repro ✔ | A |
| A6 | **A parameter reassigned inside a helper** (`opts = opts \|\| defaults`) isn't tracked, so the box reads the caller's argument, which is wrong when it's undefined. | medium | repro | F1 |
| A7 | **`this` in an inlined method isn't rewritten to the object it's called on.** Boxes read `this.strict` inside a function that has no `this`. Seen on Flagsmith. The receiver is also missing from the inline cache key. | high (readability) | repro | F2, A |
| A8 | **Constant folding goes into nested function bodies and declaration names.** One Flagsmith box was about 1,500 characters of garbled code. | high (readability) | repro | F2 |
| A9 | **Checks inside callbacks** (`.some`, `.every`, `.find`, `.filter`) aren't drawn. Unleash's main decision, which strategy is enabled, is missing entirely. | medium-high (design gap) | repro | F2 |
| A10 | **`catch` blocks aren't drawn.** Only a warning is shown, and the completeness check then charges for a test to rediscover the gap. | medium | repro | F2 |

## B. Verify can report the wrong status

| # | Finding | Severity | Evidence | From |
|---|---|---|---|---|
| B1 | **A passing test that never calls `run()` is marked verified,** through the fallback for old-style tests. `it('p01', () => {})` verifies every path. In a file with two tests, one calling `run()` and one empty, the trace also overrides the runner's rejection. | blocker | read ✔, repro | F1, A |
| B2 | **`await` conditions record the promise, not its value.** `if (await check())` is instrumented as `await probe(check())`. The promise is always truthy, so the "yes" path verified while the code went "no". Async code is everywhere in services and handlers. | blocker | repro ✔ | A |
| B3 | **Recorded answers aren't tied to a call.** The walk takes the first recorded answer for a box, so another call to the same helper, an earlier loop item, or a second call inside `run()` can supply it. Both F1 and A got a false verified this way; A's case combined a check from one call with the return from another. Loops with several items give false "failed". | blocker | repro | F1, A |
| B4 | **Several checks don't fail when they should:** <ul><li>A `return` whose code changed after the chart was made loses its probe, and the path stays verified, even with "code changed" set.</li><li>"No instrumentation" counts as verified.</li><li>A `throw` outcome is satisfied by any throw, including a different error or a crash in a dependency.</li></ul> | blocker | repro | F1, A |
| B5 | **Probes move by plain text search after edits.** The probe for `x` moved into the word `export`, and the one for `on` into `function`, which broke the build. Moving into a string, or into another function with the same text, reports "the chart is missing a branch". | high | repro | F1, A |
| B6 | **Opening the project through a symlink** (macOS `/tmp`, pnpm) means nothing gets instrumented. Every path is then reported failed, blaming the chart. | high | repro | F2 |
| B7 | **The completeness check counts code reached by tests that failed or didn't follow their path.** It merges recorded runs from every test, accepted or not, and reports the places as "stayed on the chart". | high | repro | A |
| B8 | **"Impossible" is the test writer's word, kept forever.** "Because I say so" with an empty conflict list is accepted for paths and for completeness places ("can't run"). It's never checked against recorded runs, it narrows later path choices, and it doesn't expire when the code changes. | high | repro | F1, A |
| B9 | **Labels are only checked for structure.** "Is x false?" on `if (x)` passes every check. The LLM judge runs only on the fixture. | high (design gap) | repro | F1, A |
| B10 | **A test that mocks a helper drawn in the chart** gives "the chart may be missing a branch" instead of "the test mocked a charted helper". | medium | repro | F1 |
| B11 | **Completeness says "stayed on the chart" when the code merely didn't contradict it.** A branch folded into a value (`score -= 100`) counts as covered. Places are also found by function name, so two same-named functions in one file get mixed up. | medium / low | read | F1 |
| B12 | **Generated tests run in the same process as the trace recorder,** so a test could write its own trace. That's not an issue with an honest writer, but it limits how strong the claim can be. | low (design) | read | A |

## C. It won't run on many real repos yet

| # | Finding | Severity | Evidence | From |
|---|---|---|---|---|
| C1 | **Generated tests don't resolve tsconfig path aliases** (`@/…`), and the project's Vitest or Vite config, setup files and import-time configuration are ignored. A module that checks an environment variable at import breaks every test. | blocker (for alias users) | repro | F2, A |
| C2 | **The source shown to the test writer can leave out the function under test.** Dependencies come first, cut off at 60k characters, so the entry file gets dropped. | high | repro | F2, A |
| C3 | **Windows paths** never match: forward slashes from ts-morph vs `path.sep`. | blocker on Windows | read | F2 |
| C4 | **Some function shapes aren't found:** overloaded functions, class-property arrows, and wrapped handlers (`withAuth(async (req) => …)`). | medium | repro | F2 |
| C5 | **A monorepo root whose tsconfig only has `references`** loads no files, and Vantle then says "no functions are marked". | medium | repro | F2 |
| C6 | **Errors are swallowed:** `scan` ignores extractor crashes, and path listing skips arrows to unknown boxes. That's how A3 stayed hidden. | medium | read | F2 |
| C7 | **Scale:** path selection lists up to 100,000 paths, and label validation compares paths pairwise. That's fine at GrowthBook's size, but it will hit a wall on larger functions. | low for now | read | A |

## What the claim should be (A's main design point)

A's verdict: useful foundations, but the verified, impossible and completeness signals don't support the claim that the chart is proven. Even with every bug fixed, one test per arrow is evidence, not proof that the chart matches the code for all inputs. A suggests reporting separate facts instead of one strong word:
- the labels passed structural checks;
- this run took exactly this route;
- this return or throw fired;
- these places in the code ran;
- these constructs aren't supported yet;
- these labels and assumptions need review.

"Impossible" needs a higher bar than "the writer couldn't build a test".

I agree, and it's a cheap change compared with the bugs. Proposed wording: **verified** means "a test drove the real code through exactly this route to this outcome". "Proves" and "complete" come out of the README and SPEC. Code Vantle can't chart, such as effects through properties, callbacks and `catch`, is listed in the output as **not charted**, not silently left out. "Impossible" becomes **couldn't build a test**, with the writer's reason, unless recorded runs back it up.

## Code health

- **Extractor caches:** the extractor has three caches (`memoCache`, `inlined`, `joins`) with implicit keys, and A1 and A3 are both a key missing from one of them. Recommendation: one cache object per inlined call, plus an integrity check after extraction (every arrow has a target, every box has at least two exits) that fails loudly. (F2)
- **Execution identity:** the chart shares boxes across calls for presentation, and the route check tries to rebuild executions from that shared graph. Separating "which box" from "which call" is the root fix for B3. (A)
- **Instrumentation code:** the helper, setup and Vite plugin are source strings in `run.ts`, with no type checking or direct unit tests. Move them into real modules, and add tests that compare instrumented and plain runs (async, short-circuit, `return await`). (A)
- **Verify duplication:** `verifyFlow` and `checkCompleteness` each have their own write → run → classify → repair loop, and they should share one. (F2)
- **Dead code:** the `opaque` node kind, `expectOutcome` and `expectThrow`. (F2)

## What the reviewers found solid

- **Instrumentation:** no reviewer could make it change what the code does, apart from the `await` boundary (B2).
- **Extraction design:** forward walking with continuations, value tracking, pruning by last use and step-box widening are careful, and far more inspectable than asking an LLM for the graph.
- **Label checks:** structural validation does real work.
- **Practical verify choices:** saved tests, stable path signatures, bounded repairs, and drift detection for boxes whose code changed.
- **Modules:** they can be tested on their own, which made every repro easy.
- **Extraction setup:** handles NodeNext `.js` imports, decorators, TSX and `extends`. `scan` was useful on all three repos.

## Proposed fixes

1. **Fail closed** (B1, B2, B4, B5, B6, B7, B8, B10, and the wording above). Any status Vantle can't back up becomes unverified or broken, never verified or failed:
   - require exactly one test that ran and recorded a run;
   - probe `await` after it resolves;
   - relocate probes by syntax tree, not text;
   - give `throw` outcomes their own probes;
   - report "nothing was instrumented" as broken;
   - count completeness only from accepted tests;
   - rename "impossible" to "couldn't build a test" unless recorded runs back it up, and expire it when the code changes;
   - update the README and SPEC claims.
2. **Extraction correctness** (A1–A8, C6):
   - a cache per inlined call;
   - mutations through properties and methods make the value unknown, and branches with effects are listed as not charted;
   - only pure-looking expressions count as the same value twice;
   - track parameters;
   - real values for enum cases;
   - no folding into nested functions;
   - rewrite `this`;
   - the integrity check.
3. **Tie recorded answers to calls** (B3). Each inlined call gets its own ID in the trace, entries and exits are recorded, and the walk only accepts answers and returns from the right call. This is the deepest change in the list.
4. **Runs on real repos** (C1–C5):
   - path aliases from tsconfig;
   - `--setup` and `--env-file` options;
   - a check that the module can be imported before paying for tests;
   - the entry file and charted files first in the writer's context;
   - real paths and `/` separators;
   - more function shapes;
   - a clear monorepo message.

**Design questions for later:**
- **Label truth (B9):** have the labeler state what "yes" means for each box, and check it with a second model; or keep labels as "needs review".
- **Callbacks (A9)** and **`catch` (A10)**.
- **Isolating generated tests from the recorder (B12).**
- **Scale (C7).**

These come after the field test shows how often they occur.

**Round 2:** before the public release, as planned. It should also re-check fixes 1–3, since they change what "verified" means.

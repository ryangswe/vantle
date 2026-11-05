# M4: Vantle on a real repo (GrowthBook)

**Target:** [GrowthBook](https://github.com/growthbook/growthbook)'s JavaScript SDK at commit `de93c5d`, `packages/sdk-js` (about 5,400 lines of TypeScript).
**Function:** `runExperiment` in `src/core.ts`, which answers "Is this user in the experiment, and which variation do they get?" It's 415 lines, written as a numbered list of guard checks, the same shape as Slack's chart.
**How to reproduce:** `.github/workflows/m4-growthbook.yml` (not in the public repo yet; it needs the author's Anthropic account) checks out the pinned commit, adds the `@vantle` marker, and runs scan, generate and verify. It posts the results on the commit.

## Results

| Step | Result |
|---|---|
| `scan` | 2 seconds for the whole SDK. `runExperiment` ranks second, behind `evalOperatorCondition` (the rule engine's operator switch, which is a fair pick in its own right). |
| Extract | 24 boxes, 6 outcomes, 61 paths, 0.3 seconds. |
| Label | One attempt, 8,363 in / 2,146 out tokens, about $0.08, 17 seconds. Sample labels in source order: "Fewer than 2 variations?", "SDK disabled globally or for user?", "Page URL not targeted?", "Variation forced in URL query string?", "Variation forced via dev tools?", "Experiment draft or inactive?", "User has the hash attribute?", "Sticky bucket already found?", "User filtered out?", "User outside the experiment namespace?", "User fails targeting condition?", "Any prerequisite cyclic?", "This prerequisite passes?", "Sticky bucket version blocked?", "User outside coverage (no variation)?", "Experiment has a forced variation?", "QA mode on globally or for user?" |
| Verify, first run | Claude wrote 40 tests (24 paths, plus repairs and gap-filling) in 196 seconds, for about $2.22. 5 verified, 17 failed, 2 impossible; 11 of 48 arrows verified. |
| Verify, after fix 5 | The same saved tests were re-checked in 3.6 seconds with no Claude calls: **18 verified, 4 failed, 2 impossible; 44 of 48 arrows verified.** |

The 2 impossible paths are real coupling, and the reasons are right. "A sticky bucket was found" and "its version is blocked" can't both be true. A found sticky bucket also always means the user has a variation.

The 4 remaining failures look like wrong predictions in the tests, not wrong routes. For example, a test expected `key: 'exp'` (the experiment's key), but `result.key` is the variation's key (`'0'`). See item 10.

## What broke, and what was fixed during M4

| # | Problem | Effect on GrowthBook | Status |
|---|---|---|---|
| 1 | **`scan` ranked hub functions first.** Its score counted every decision reachable through any call, and a few methods call almost everything. | The top 15 results were `init`, `setURL` and similar, each "reaching" 550+ decisions. `runExperiment` wasn't listed. | **Fixed.** `scan` now ranks by the size of the chart extraction would actually build. `runExperiment` ranks among the top two, in 2 seconds for the whole SDK. |
| 2 | **`scan` counted logging guards and defaults as decisions**, such as `NODE_ENV !== "production" && log(...)` and `url \|\| ""`. | `runExperiment` showed 81 decisions; 52 are real. | **Fixed.** Only `if`, `case`, ternaries, and `&&`/`\|\|` inside conditions or return values count. |
| 3 | **Loops hid their early returns.** A loop was one opaque box. | The prerequisites check (step 8.05: a cyclic prerequisite, or a failing prerequisite, means the user isn't in the experiment) was missing from the chart. Verification couldn't notice, because it only tests paths the chart has. | **Fixed.** A loop body is followed as one pass: its checks become boxes tagged with the loop, and its early returns become outcomes. |
| 4 | **Generic machinery drowned the chart.** Following the prerequisites loop pulled in `evalCondition`, GrowthBook's MongoDB-style rule interpreter. | The chart grew from 22 to 137 boxes, mostly query operators like `$gt` and `$regex`. | **Fixed.** Recursive helpers (rule engines and parsers walk data, they don't make product decisions) stay as one box. Any helper that would add more than 40 boxes also stays as one box (`--max-inline`). The chart is 24 boxes. |
| 5 | **Object outcomes were compared strictly.** The Slack fixture returns `true` or `false`; `runExperiment` returns objects. The test writer reasonably used `expect.objectContaining(...)`, and Vantle's helper rejected it. | 17 of 24 paths were marked failed although the code took the right route. | **Fixed.** The helper compares with Vitest's `toEqual`, so partial matchers work. Wrong outcomes are still reported as failed. |
| 6 | **Variables that change mid-function aren't tracked.** `let assigned = -1`, `foundStickyBucket` and `stickyBucketVersionIsBlocked` are set inside an `if` with no early return, so the extractor drops that `if`. | The sticky-bucketing setup is missing from the chart, and later boxes like "Sticky bucket found?" look like independent inputs. Verification marks some combinations impossible, correctly, for example "found a sticky bucket" together with "its version is blocked". | **Fixed after M4** with variable tracking: statements are walked forward with each variable's current value. "Sticky bucketing enabled?" and "Sticky bucket found?" are now boxes, and later checks name what they actually read. The chart grew from 24 to 46 boxes, because checks after sticky bucketing now appear once per branch (see item 11). Verified: 37 paths, 0 failed, 2 impossible; 86 of 88 arrows (the other 2 are only on the impossible paths). Labeling took 2 attempts ($0.26); writing 57 tests cost $2.77. |
| 7 | **Destructured constants aren't folded.** In `const { hashValue } = getHashAttribute(...)`, the box reads `hashValue` instead of saying where the value comes from. | The labels still read well, because the labeler sees the source, but the raw chart is less clear. | **Fixed:** destructured constants fold to `getHashAttribute(...).hashValue`. |
| 8 | **Verification proves the chart's paths, not the chart's completeness.** If the extractor misses a branch, no test is generated for it. | This is how item 3 went unnoticed. | **Fixed after M4.** Verify also marks every return, throw, catch block, and branch that matters in the charted code. Any place no path test ran gets a test written to reach it, and the chart is walked with the code's answers. If the code leaves the chart, the place is reported as missing from the chart. On GrowthBook, path tests ran all 24 such places in the charted code, so nothing is missing. On the Slack fixture, an early return added after the chart was made is reported as missing, with one extra test ($0.03), while every path test still passes. |
| 9 | **Verification is slower and costlier on real code.** | The first run wrote 40 tests in 196 seconds for about $2.22. The Slack fixture took 20 tests, 65 seconds and about $0.41. Setting up GrowthBook's context objects and sticky-bucket documents makes each test longer, and more of them need a repair. | **Fixed after M4.** Writing GrowthBook's tests from scratch now costs $0.53 instead of $1.92, and takes 72 seconds instead of 148, with the same results. See below. |


**10. Verification checks outcome values, not routes.** *Fixed after M4 with route-based verification. On GrowthBook: 22 verified, 0 failed, 2 impossible; 48 of 48 arrows verified, for $1.63.* This was the biggest open item. With `true`/`false` outcomes, a matching value means the code took the chart's route. With object outcomes, the test writer has to predict the whole object, and a wrong guess about any field ("key", "hashValue") shows up as **failed**, even when the route is right. That makes "failed" untrustworthy on real code, which undermines the core promise. The fix for v1 is to check routes directly: while running a path test, Vantle instruments the charted code to record which boxes were evaluated, with what answers, and which return fired. The test writer then only has to drive the inputs; it never predicts outputs. A failure can then say exactly where the code left the chart's path ("went *yes* at 'User filtered out?' where the chart says *no*").


**11. Variable tracking duplicates shared checks.** *Fixed: when keeping branches apart would draw more than 3 boxes twice, the checks after the join are drawn once and each branch gets a step box showing what it set. GrowthBook went from 46 boxes to 27, with every check once.* When a branch sets a variable that a later check reads, everything in between is drawn once per value. In GrowthBook, the filter and targeting checks appear twice: once with sticky bucketing off, and once with it on but no bucket found. The chart is accurate but noisier. Ideas: draw the shared part once as a "subchart" that both branches enter, or let a reader collapse duplicates in the UI.

**9. What verification cost, and what changed.** Measured on GrowthBook with every test written from scratch (22 paths, 57 arrows):

| Change | Cost | Repairs | Why it helped |
|---|---|---|---|
| Before | $1.92 | 13 | Each of 10 requests sent about 30k tokens of source code uncached; input was 64% of the cost. |
| Cache the shared prompt | $1.06 | 17 | The source code, imports and boxes come first in every request and are cached, so later requests pay 5% of the input price for them. |
| Show a working test to later batches | $0.72 | 4 | Almost every broken first draft failed the same way: `ctx.global.log is not a function`, a logging hook GrowthBook calls in development builds. Writing one batch first and showing a test that works to the rest fixes that once instead of 17 times. |
| Low effort for test writing | **$0.53** | 4 | The writer thinks less per test. Results were the same as medium in all three runs, on GrowthBook and the Slack fixture. |

The Slack fixture went from $0.40 to $0.28. Other settings, all with the changes above:
- **Sonnet 5.5 at medium effort:** about $0.35. It matched Opus in 3 of 4 GrowthBook runs and on the fixture. The other run lost 2 paths, before the fix that keeps a failed first batch from spreading its mistake.
- **Haiku 5.5:** $0.08, but only 10 of 22 paths verified.

`--model` and `--effort` choose the writer. Opus 5.5 stays the default.

## Takeaways

- **The approach holds up on real code.** The extracted chart follows GrowthBook's own numbered comments: too few variations, context disabled, URL targeting, forced by querystring, forced in dev tools, draft or inactive, missing hash attribute, filters or namespace, include function, targeting condition, prerequisites, groups, URL regex, bucketing, sticky-bucket version blocked, not in coverage, forced variation, QA mode, stopped, then assignment.
- **Labeling works unchanged:** one attempt, about $0.08.
- **Most fixes were about what to leave out.** Logging guards, generic interpreters and hub functions all make a chart bigger without making it more useful. Choosing the right level of detail is a core product question, not an edge case.
- **Impossible paths turned out to be the most interesting output.** On real code, they point straight at hidden coupling between checks, which a reader of the chart would otherwise assume are independent.

## v1 backlog from M4

1. ~~**Route-based verification** (item 10)~~: done. Tests only drive inputs, the charted code is instrumented, and the chart is walked with the recorded answers.
2. ~~Track `let` variables assigned in branches (item 6)~~ and ~~draw the checks it duplicated once (item 11)~~: done.
3. ~~Coverage-based completeness check for verification (item 8)~~: done.
4. ~~Fold destructured constants (item 7)~~: done.
5. ~~Reduce verification cost on large charts (item 9)~~: done.
6. Choosing the level of detail interactively (keep as one box or expand) belongs with the "editing the chart's shape" idea in VISION.md.

# Vantle v0 spec

Status: draft for review
Scope: v0 only. Long-term ideas live in [VISION.md](./VISION.md).

## 1. What v0 does

You mark one TypeScript function with a comment. Vantle turns it into a decision flowchart someone outside the code can read, in the style of Slack's "Should we send a notification?" chart, and generates tests that check every path in the chart against the real code.

```ts
// @vantle: "Should we send a notification?"
export function shouldNotify(msg: Message, user: User, channel: Channel): boolean {
  ...
}
```

```
$ vantle generate
✔ shouldNotify  14 decisions · 2 outcomes · 19 paths
$ vantle verify
✔ 19/19 paths verified
```

Charts that just look plausible aren't enough. Every path has to be **verified** (a generated test passes), **failed** (a test shows the chart is wrong), or **unverified** (no test could be built), and the output always shows which.

## 2. Who v0 is for

The engineer who owns tangled business logic and keeps explaining it to PMs, new hires and reviewers. v0 should please that one person. PMs, eng leads and teams come later.

## 3. Scope

**In v0**

- TypeScript codebases (Node 20+, `tsconfig.json` present)
- Entry points marked with `// @vantle: "<question>"`
- Following calls into other functions in the same repo, up to a depth limit
- An LLM labeling pass with strict validation
- Mermaid output, which GitHub renders in markdown automatically
- Path tests written with vitest
- `vantle scan` to find branch-heavy functions worth marking
- Logging cost and time for every run

**Not in v0**

Other languages; tracing across services; CI and PR behavior diffs; a UI or viewer; editing charts; layout tuning; caching; spec comparison; monorepo-specific handling.

## 4. Concepts

| Term | Meaning |
|---|---|
| **Flow** | One chart for one marked entry point. |
| **Decision** | A branch point: `if`, `else if`, ternary, `switch` case, or a `&&`/`||` that controls a return. |
| **Outcome** | A way the function ends: a `return` value or a `throw`. For a boolean function, these become YES and NO. |
| **Path** | A sequence of decision answers from the start to one outcome. |
| **Input source** | Where a decision's data comes from. This drives the legend (§7). |

## 5. Pipeline

Each step is marked **[D]** (deterministic, no LLM) or **[L]** (LLM). The LLM steps take JSON in and produce JSON out, and the next deterministic step validates their output. That split lets a Claude Code skill or MCP server do the LLM steps later while reusing the CLI for everything else.

1. **Find [D].** Scan the repo for `@vantle:` comments directly above a function, method or arrow function.
2. **Extract [D].** Use ts-morph (the TypeScript compiler API) to build the **raw graph**:
   - Walk the entry function's control flow and record decisions, outcomes and edges.
   - When a decision or return depends on a call into another function in the repo, inline that function up to `--depth` levels (default 8). Only functions with branches of their own are inlined. Recursive helpers (rule engines, parsers) and helpers that would add more than `--max-inline` boxes (default 40) stay as one box. A chart with more than `--max-boxes` boxes (default 50) follows helpers less deep, using the deepest depth that brings it under; the helpers past it are one box each, and a warning says so. A chart too big even with only the entry's own helpers drawn is drawn in full, since collapsing helpers wouldn't make it readable.
   - Loop bodies are followed as one pass: checks inside become boxes tagged with the loop, and early returns become outcomes.
   - Local variables are tracked. Statements are walked forward with each variable's current value, so an `if` that only sets a flag still becomes a box, later checks are rewritten with the value each branch assigned, and checks that the values decide (`let found = false` … `if (!found)`) are resolved instead of drawn. Destructured constants are folded too. Variables that are never read again are dropped, so they don't split the chart. Variables changed inside a loop are unknown after it, and more than 6 combinations of values at one statement widens them to unknown. Parameters reassigned in the function (`opts = opts || defaults`) are tracked the same way.
   - Changes through a variable, such as `x.a = 1`, `x.push(...)`, `delete x.a`, `Object.assign(x, ...)`, a method called for its effect (`user.ban()`) or `this.cache = ...`, give that property (or the whole object) a new version. A later check that reads it isn't treated as the same question as a check before the change, and a branch that only pushes to a list is drawn. Changes are tracked by property path, so logging into `ctx.user.log` doesn't affect a check of `ctx.user.plan`. For drawing, a change counts where Vantle sees it read later: the property, destructuring it, returning the object, or passing it to a call that is a check (`if (isValid(order))`) or to a returned helper that reads that property. A change nothing visibly reads isn't drawn, so it doesn't split the chart; the branch is listed as not charted.
   - For which paths can happen, Vantle doesn't rely on that. A check after a change that could alter what it reads is a separate question from the same check before it, on every path. This can list extra paths that can't happen, but is meant never to hide one that can:
     - **A write to a field** (`a.admin = false`) changes that field on any object, since another variable can be the same object (an alias, `holder.user`).
     - **A change to a whole object** (`x.push(…)`, `Object.assign(x, …)`, handing it to code Vantle can't see) changes any field its type declares. When the type takes any key, it changes fields of objects whose type is compatible with it.
     - **Code Vantle can't see** is assumed to change what it's given, and the object a method is called on. An untyped object whose call result is used (`db.select().where()`, a query builder) is taken as a value.
     - **A lookup** (a check that calls something) asked again after a call Vantle can't see is a new question. A call written inside a check is itself a lookup, not a change to anything but what it's given, so `if (tryLock()) … if (isLocked())` still reads as one question.
     - **Repo helpers** count as changing what their bodies change, through every helper they call, including callbacks they're given, constructors, setters and subclass overrides. Writing a module variable counts too.
     - **Pure built-ins don't change anything:** methods of strings, numbers and dates, `Math`, `JSON`, and array and set methods like `map`, `includes` and `difference`.
     - **What counts as before:** a change in the other branch of an `if`, or in a branch that has returned or thrown, can't come before a check. A change anywhere in a loop around the check, or in a function kept to be called later, can.
   - Objects, arrays and values over 60 characters are shown by name rather than spelled out. A property of an object literal that hasn't changed reads as its value (`cfg.level` after `const cfg = { level }`). A returned object that was changed on the way shows it (`res (changed at line 5)`), and a helper that returns one of its own variables is named by the call (`make('A', n) → out`).
   - When a box shows a variable by name, or a helper's own variable, it gets an identity, so two calls of a helper with different arguments are never treated as one question. The same goes for boxes before and after a change. When checks after a join are drawn once, objects keep a "changed before here" mark, and the branch's step box says what changed ("reasons changed (line 6)").
   - Where branches that set variables differently rejoin, and keeping them apart would draw more than `maxDuplicates` (3) boxes twice, the checks after the join are drawn once. Every such join is widened at once, then the function is extracted again, until no join duplicates that much (at most 40 rounds). Each branch gets a **step box** showing what it set ("Use the user's sticky bucket"). Literal values a step sets are facts for path listing, so a path can't answer `found` = yes after a step that set `found = false`. A simple helper like `isThreadMessage(msg)` stays as one box, which is usually what a reader wants. Calls into `node_modules`, I/O or unresolved code stay as **inputs** of the box that uses them.
   - Rewrite every condition in terms of the entry function's parameters: an inlined function's parameters become the caller's arguments (an argument over 60 characters leaves the parameter's name, so a label doesn't repeat it), `this` in an inlined method becomes the object it was called on, and local constants become their initial values (constants longer than 160 characters keep their name). Code inside a nested function, such as a callback, is left as written. A helper called twice with the same arguments and destinations becomes one shared set of boxes; with different arguments, it's walked again.
   - Two boxes with the same code are the same question on a path, so a path that answers them differently is ruled out. That isn't safe for calls that consume or sample something (`next()`, `queue.take(1)`, `rollDie(6)`), time, randomness and `new`, so those boxes get their own identity. Other calls are taken to be lookups.
   - A missing argument takes the parameter's default. A `switch` on a value known on that path picks its case only when every case's value is known (including enum members and constants); `switch (true)` is read as an if/else chain. Numeric enums are never treated as closed, since any number can be assigned to one. Only `===` and `!==` (and `== null`) are facts about a value; other `==` comparisons convert types, so they aren't.
   - Switch cases written as names (`case Status.Active:`) record the value they stand for, and a switch that handles every member of an enum gets no "other" arrow.
   - **Helpers that can throw.** A repo helper that can throw is drawn wherever it always runs: called as a statement (`assertNotBanned(u)`), in arguments, initializers, returns, and `if` and `switch` subjects. Its throws become outcomes, and everything else continues past the call. A helper that would add more than 10 boxes this way is listed instead, as is one that only runs on some paths (`a && f()`) or only throws from a callback.
   - **`try` and `catch`.** A throw inside a `try`, or from a helper it calls, goes into the `catch` with the caller's variables, and the catch carries on as written. A catch that only rethrows keeps each throw its own outcome. `finally` blocks aren't followed.
   - **Not charted.** Code that affects the result but can't be drawn is listed with the chart instead of left out silently:
     - a branch whose only effect is setting a property or calling a method (`res.body = ...`), or setting a variable used later that the chart can't tell apart;
     - checks inside callbacks (`items.some(i => ...)`), and callbacks that can throw;
     - helpers that can throw but aren't drawn;
     - a `catch` that something Vantle can't see into could throw into (a call outside the repo, `new`, `await`), or that no drawn throw reaches;
     - a `finally` that decides something.
   - **Integrity check.** A chart with an arrow to a missing box, or a box without its exits, fails extraction loudly. So does listing paths through one. `scan` reports functions it couldn't chart, with the reason, instead of skipping them.
   - Give each node a stable ID and source location (§6).
   - Give each decision an input-source hint (§7), worked out by following its variables back to where they come from.
3. **Label [L].** Send the raw graph and the relevant source snippets to the model. It returns the **labeled graph**:
   - Product-language labels ("User in DnD?" instead of `user.dndEnd > now`)
   - Merges of equivalent or trivial nodes
   - A legend category per decision
   - A one-sentence rationale per label, quoting the code

   The model never returns a graph. It answers in a fixed JSON format that names boxes by short IDs (`n1`, `o1`), and Vantle builds the labeled chart from that answer. If a safety classifier declines the request, it's retried on Anthropic's recommended fallback model.
4. **Validate [D].** Reject the labeled graph unless all of these hold:
   - Every labeled node maps to at least one raw node, and every raw node maps to exactly one labeled node.
   - Every outcome is kept, and none are added.
   - Each labeled edge corresponds to a path in the raw graph.
   - Every path in the raw graph still exists after merging. If not, the merge is invalid.
   - The same condition gets the same label everywhere, so readers don't take one check for two.
   - Labels are one line, at most 90 characters, and each box has a rationale. Case labels only go on switches, and only for cases the switch has.
   - Finally, the labeled chart must behave exactly like the raw one for every input.

   If validation fails, retry the label step once with the errors included, then stop with a clear message.
5. **Render [D].** Write the labeled graph to `.vantle/flows/<flow>.json`, plus `<flow>.mmd` and `<flow>.md` (Mermaid embedded in markdown, with the legend and path status). The raw graph from step 2 is kept next to it as `<flow>.raw.json`.
6. **Verify [L+D].**
   - **[D]** Pick a set of paths that together cover every arrow in the chart at least once. All paths are still counted and reported. Testing every path doesn't scale: branches that rejoin multiply the count. The Slack fixture has 1,311 paths, and 20 of them cover all 57 arrows. `--all-paths` tests every path for small flows.
   - **[L]** For each path, Claude writes a Vitest test file that sets up inputs to drive the real code through that path's answers, and calls the function once through Vantle's `run()` helper. Tests don't assert outcomes. Tests are written five paths per request, three requests at a time.
   - **[D] Route checks.** While tests run, a Vite plugin instruments the charted code. Every box records the answer it gave (for `await` conditions, the resolved value), and every non-literal outcome records which `return` or `throw` fired. A result only counts as coming from a return or throw when it's exactly the value that statement handed back.
     - **Answers come from the right call.** Each box records which inlined calls it sits inside. Every charted function's body starts by recording a run and keeping its ID in a local variable, which each probe in that body passes along, so what a probe records belongs to the run it happened in, even with recursion or async runs that interleave. Each inlined call marks itself after its arguments run, just before the call, and the next entry of the function it names takes the mark, so every run knows the call it came from. Other charted code that runs in between, such as the callee's default parameters, leaves the mark alone. The mark lapses once the calling run records anything else. One gap remains: if the named function is never entered (an override, a wrapper or a spy runs instead) and the substitute calls it before the caller records anything, that inner run takes the mark. A box only takes its answer from the run reached through its own calls, and boxes reached through the same calls take answers from the same run. So a helper also called somewhere the chart doesn't draw doesn't supply a box's answer, the result, or credit for code reached. A helper whose boxes are shared by two calls takes answers from either. Charts made before this are checked the old way. Vantle walks the chart using the recorded answers, and the result decides the status:
     - **verified:** a test drove the real code through exactly this route to this outcome. It's evidence for those inputs, not a proof that the chart matches the code for every input.
     - **failed:** the code contradicted the chart. It skipped a box the chart says comes next, which usually means a missing branch. Or it ended with something other than the chart's outcome.
     - **missed:** the test didn't drive the code down the path. A new test gets one repair, with the exact box where the code went the other way. A saved test that used to follow its path and now doesn't means the code changed, so it counts as failed.
   - **Failing closed.** Anything Vantle can't back up stays **unverified**, never verified or failed:
     - a test file that doesn't hold exactly one test, a test that never calls the function through `run()` or never enters it, or one that calls it more than once;
     - a box or return with no instrumentation, or instrumented code that never loaded (a mocked module, a file loaded from another path);
     - a test that mocks a helper the chart draws, so that helper's boxes never ran;
     - a box that got a promise instead of a value;
     - a result that didn't come from the chart's return or throw, such as a different error, a crash in a dependency, or a value from a `catch`;
     - a box whose code can't be found any more. The chart is then **out of date**, and `verify` exits with code 3 until it's regenerated.
     A saved test is only reported failed for missing its path if it followed that path before.
   - Probes remember their expression's text. After the code is edited, a probe moves only to where that text is a whole expression in the same function, never into a longer word, a string, a type or another function. When the expression appears more than once there, it keeps to the same copy. If that can't be done, the chart is reported out of date. Files are matched by their real path, so projects opened through a symlink work.
   - **[L] Couldn't build a test.** If the writer finds no inputs for a path, for example because the chart treats two checks as independent but the code computes them from the same data, it says so with a reason and names the conflicting boxes and answers. That's the writer's claim, not a finding, so it's reported as **couldn't build a test** with the reason. Later selections skip paths that force the same combination. The claim is dropped when any test run gives those same answers, and it expires whenever the charted code changes. `--all-paths` tests every other path too, so claims can be disproved.
   - A test that errors before reaching the function gets one repair. If it still errors, the path stays **unverified**.
   - **[D]** If paths without a working test leave arrows uncovered, Vantle picks other paths for just those arrows, once. An arrow that's still only on paths needing answers the writer said can't happen together is listed with that claim, so every arrow is either tested or explained. Claims about paths the chart no longer has are dropped.
   - **[D+L] Completeness.** Path tests only follow the chart, so a branch the extractor missed is code they never run. The plugin also marks every `return` and `throw` in the charted functions (the entry function and every helper drawn inline), every `catch` block, and every branch that sets a variable read later or leaves a loop early. Only path tests that verified count as having run a place. Places that no such test ran get a test of their own: Claude writes inputs that make the code get there, and Vantle walks the chart with the answers the code gave.
     - **stayed on the chart:** the code followed the chart to the outcome it produced, so the chart already covers this code.
     - **missing from the chart:** the code skipped a box the chart says comes next, or ended differently. The chart is missing a branch. `verify` exits with code 3, as it does for failed paths.
     - **couldn't build a test:** the writer found no inputs that get there (often dead code), with the reason. Like the path claim, it expires when the code changes.
     - **not reached:** no test got there yet. At most 20 new tests of this kind are written per run.
   - **Cost.** Each request to the test writer starts with the same text: the function, imports, boxes and source code. It's marked for prompt caching, and only the batch's paths follow it. The first batch is written on its own, so it fills the cache for the rest. Once any test runs the function without errors, it's shown to the writer as a working example. Broken first drafts usually fail the same way, such as a missing mock or a context field the code reads, so one example prevents most repairs. Tests are written at low effort by default; on GrowthBook and the Slack fixture this cost about 30% less than medium and verified the same paths. `--effort` and `--model` override it.
   - Generated tests are saved to `.vantle/tests/<flow>/`, with a manifest keyed by a hash of each path's steps. Re-running verify runs saved tests first and only writes tests for arrows they don't cover. Re-running is therefore free, and it catches code that changed after the chart was made. Path IDs stay the same across runs.

## 6. Stable node IDs

A node ID has to survive unrelated edits. Notes, links and diffs from VISION.md all depend on that.

```
<flowId>:<structuralPath>:<conditionHash>
flowId          = <repo-relative file>#<qualified function name>
structuralPath  = position in the AST walk, e.g. body/if[2]/else/if[0]
conditionHash   = short hash of the normalized condition text
```

Line numbers are stored but never used in IDs. In v0, IDs stay the same when you edit code elsewhere in the file. If you edit the branch itself, the node gets a new ID. That's acceptable for v0. Matching nodes across edits is planned for later (see VISION.md, "Stable identity across edits").

Every node also records `module` (repo-relative directory) and `symbol` (qualified function name), so a future structure map can link straight to it.

## 7. Legend categories

| Category | Data comes from | Slack example |
|---|---|---|
| `pref` | User or workspace settings, feature flags, config | Channel muted? |
| `state` | Runtime state read from a store or service | User in DnD? |
| `input` | The function's arguments or parsed request/message data | @channel message? |
| `external` | Unresolved or I/O calls Vantle couldn't look into | — |

The extractor makes a guess from naming patterns and import sources. The LLM confirms or changes it. Both values are kept in the JSON.

## 8. Data formats

All formats are defined with zod schemas, in one place: `src/schema/`.

```jsonc
// .vantle/flows/should-notify.json (abridged)
{
  "schemaVersion": 0,
  "flow": {
    "id": "src/notify.ts#shouldNotify",
    "question": "Should we send a notification?",
    "generatedAt": "...",
    "sourceHash": "..."            // hash of every source file read
  },
  "nodes": [
    {
      "id": "src/notify.ts#shouldNotify:body/if[0]:a1b2",
      "kind": "decision",           // decision | outcome | opaque (a loop, shown as one box)
      "branch": "boolean",          // boolean (yes/no) | switch (one arrow per case)
      "label": "Channel muted?",
      "rawLabel": "channel.isMuted(user.id)",
      "category": "pref",
      "categoryHint": "pref",
      "rationale": "...",
      "source": { "file": "src/notify.ts", "line": 12, "module": "src", "symbol": "shouldNotify" },
      "rawIds": ["..."]
    }
  ],
  "edges": [{ "from": "...", "to": "...", "label": "yes" }],
  "paths": [{ "id": "p01", "nodes": ["..."], "status": "verified", "test": ".vantle/tests/should-notify/p01.test.ts" }],
  "run": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "durationMs": 0 }
}
```

Human notes are **not** stored in generated files. v0 reserves `.vantle/notes.json` (node ID → notes) and keeps it untouched when charts are regenerated. Editing notes comes after v0.

## 9. CLI

| Command | Steps | Notes |
|---|---|---|
| `vantle scan [path]` | D | Ranks functions by decisions per 100 lines and lists the top N candidates to mark. |
| `vantle extract [flow]` | D | Writes only the raw graph. Useful for debugging and for the future skill. |
| `vantle label [flow]` | L | Raw graph → labeled graph. |
| `vantle validate [flow]` | D | Checks a labeled graph against its raw graph. |
| `vantle render [flow]` | D | JSON → `.mmd` / `.md`. |
| `vantle generate [flow]` | all but verify | The everyday command. |
| `vantle verify [flow]` | L+D | Generates and runs the path tests, then updates statuses. |

`vantle score <expected.json> [flow]` (development aid): compares an extracted flow to a hand-written reference by behavior and prints an input that tells them apart if they differ.

Common flags: `--depth` (default 8), `--max-boxes` (default 50), `--max-paths` (paths stored per flow, default 64), `--model`, `--dry-run` (prints what would be sent to the model and estimates cost), `--json`.

Exit codes: `0` ok · `1` usage/config error · `2` validation failed · `3` one or more paths failed verification.

## 10. Privacy and cost

- Runs locally. Users bring their own `ANTHROPIC_API_KEY`.
- Only the model provider receives code: the source of the functions Vantle reads, never the whole repo. `--dry-run` shows exactly what would be sent.
- Every run logs tokens, cost and time to the flow JSON and prints a one-line summary.

## 11. Tech stack

TypeScript on Node 22.12+ · ts-morph · vitest (for Vantle itself and for generated path tests) · zod · commander · the official Anthropic TypeScript SDK · Mermaid as text output (no rendering dependency).

## 12. Fixtures and how we score

**`fixtures/slack-notify/`** is a hand-written TypeScript version of the Slack chart (about 150 lines), with stub stores for prefs, DnD, presence and subscriptions. The correct chart is checked in as `expected.json`.

Scoring has three layers:

1. **Behavior (automatic, required to pass).** The scoring script compares the generated flow to `expected.json` by behavior, not by node names. For every combination of inputs, both graphs must give the same outcome.
2. **Labels (automatic, tracked over time).** `expected.json` also stores the reference label for each decision. An LLM judge rates each generated label against it on a short rubric: accurate, in product language, short. That gives a number we can compare across prompt and model changes.
3. **Readability (a person, the final word).** Someone who didn't write the fixture reads the chart and says whether it makes sense. The judge's score is only useful if it agrees with this.

After that comes one real open-source function picked with `vantle scan`, such as feature-flag evaluation or a permission check. There's no expected file for it; the point is to record what breaks.

## 13. Milestones

| | Goal | Done when |
|---|---|---|
| **M1** ✅ | Extractor, render, scan. No LLM. | The fixture's raw graph matches `expected.json` in behavior (with raw labels). `scan` ranks the fixture's entry point first. |
| **M2** ✅ | Label and validate | Labels on the fixture read like Slack's, and validation catches deliberately broken label output in tests. |
| **M3** ✅ | Verify | Every path in the fixture is verified. A deliberately buggy version of the fixture produces failed paths. |
| **M4** ✅ | Real repo | A chart and verify run on one open-source function, plus a written list of what broke, which becomes the v1 backlog. |

**v0 is done** when M1–M3 pass on the fixture, M4's list is written, and someone who didn't write the fixture code can read the chart.

## 14. Results so far

- **M1:** the extracted Slack chart matches `expected.json` in behavior (26 decisions, 1,311 paths).
- **M2:** with Claude Opus 5.5 at medium effort, labeling the fixture takes one attempt, about 4,800 input and 2,700 output tokens (about $0.07), and about 23 seconds. The LLM judge scores the labels 4.7 to 4.9 out of 5 against the hand-written ones across three runs, with nothing below 4. CI runs this on every push that touches `src/` or `fixtures/` (`.github/workflows/label-check.yml`) and posts the chart and scores on the commit.

- **M3:** Claude writes 20 tests for the Slack fixture in about 65 seconds, for about $0.41 (Opus 5.5, medium effort). All 20 pass, so all 57 arrows are on a verified path. Another 5 paths come back impossible, each with a reason. Examples: "Thread the user follows?" = yes implies "Thread message?" = yes, and an @here message is always a broadcast mention. After two bugs are added to the code, the saved tests re-run in about 2 seconds with no Claude calls, and exactly the two paths those bugs affect fail. CI caches the generated tests, so later runs cost nothing until the fixture or the prompt changes.

- **M4:** GrowthBook's `runExperiment` (415 lines): 24 boxes whose labels read like the SDK's own numbered steps; labeling about $0.08; 44 of 48 arrows verified. Fixed during M4: `scan` ranking and counting, loops, rule engines and oversized helpers, and object outcomes. The full list of what broke, and the v1 backlog, is in [docs/m4-growthbook.md](./docs/m4-growthbook.md). The top v1 item is route-based verification.

## 15. Decisions made in review

- **Compound conditions:** keep `a && b` as one node, as Slack's chart does with "Thread message && User subscribed?". Splitting and merging boxes by hand comes later (VISION.md, "Editing the chart's shape").
- **Non-boolean functions:** each distinct `return` expression is an outcome, and the LLM can group them for labeling. This is hard to plan in advance, so we'll adjust once real code shows what goes wrong.
- **Mocking for path tests:** the writer uses `vi.spyOn` on exported objects and `vi.mock` for exported functions. Tests run with Vitest globals and a Vantle helper, so the user's project doesn't need Vitest installed.
- **Impossible paths** are a fourth status, alongside verified, failed and unverified. They show where the chart looks more flexible than the code really is.
- **Model choice and per-chart cost target:** measure in M2 and set a budget then.

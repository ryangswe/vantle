# Design: the extractor's core, and dead arrows

Status: revised after a design review, for the owner's approval. No code written. Line numbers are `main` at `9b6e728`. Repros are in the correctness corpus (`test/correctness/corpus/`, PR #18); `docs/design/correctness-check.md` is in that PR too.

## Recommendation

1. **Fix seven holes in today's path logic first.** Each one already drops a real path from the path list today. Dead-arrow work would turn each into a missing box or outcome on the chart itself. The fixes make questions more distinct or facts weaker, so they can't hide anything.
2. **Remove dead arrows in a separate pass over the finished chart, not inside the walk.** The pass works out what is known on each arrow, then redirects that arrow past a check the known facts already decide. It never deletes an arrow outright. Most dead arrows sit on boxes two branches share: each arrow is live from one branch and dead from the other. Redirecting the arrow that comes in from one branch is safe; deleting the box's arrow isn't.
3. **Value identity separate from label text: yes, but later.** Today a box's identity is its display text plus keys patched back in about twelve places. Display rules keep dropping those keys, which was PR #16's bug class, and the same value written two ways is never matched. It's needed for Immich and two other charts, not for the first steps.
4. **No solver now.** The facts needed are equality to a literal, truthiness, and `&&`, `||`, `!` over them. `paths.ts` already has most of it. Z3 can't fix arrows on shared boxes, still needs value identity, and translating JS semantics is where the risk is.

**Order:**
1. the correctness check (A1–A3);
2. PR 1, the holes;
3. PR 2, the pass;
4. conditions as trees, and binding call arguments (neither needs value identity);
5. value identity.

**Evidence.** I tried the pass as a throwaway script, using `paths.ts`'s own `step`, on PR #16's 52 extracted charts.
- **Today's keys:** it redirects 34 arrows, including all six dead arrows the reviewer listed for PostHog `endpointFor`. But 4 of the 34 are wrong (hole 5): Payload `sanitizeField` takes "`field.type` is truthy" to mean "`field.type` isn't `'upload'`". Three charts (Infisical ×2, Cal.com `handler`) have an arrow with no answers left at all, which is a real path dropped today.
- **With truthiness keyed on its own** (PR 1): it still redirects 34, none of them like those 4, and no arrow is left with no answers.

## What's wrong in the core today

**Identity is rebuilt from display text.** Path logic treats two boxes as one question when `canonical(rawLabel) + '#' + identity` match (`paths.ts:63-64`). `rawLabel` is display text from `text()` (`extract.ts:1593`). That text deliberately shortens things:
- long arguments become the parameter's name (`shownArg`, 1432);
- long values are shown by name (`valueFor`, 806);
- long constants keep their name (`substitute`, 1670);
- constants whose source changes before they're read keep their name (`declare`, 699);
- a long receiver becomes `this` (1281).

Each shortening has to add back a key that tells values apart: `argState` (1437), the destructuring `from()` (713), `changed` (773), `widened` (997), default parameters (1272) and `identityOf` (1470). The memo key (1766) and the inline cache key (1284) use the same text-plus-keys. In reverse, `idSet.size === 0` in the caller and `({…, ids: idSet}).ids.size === 0` in the helper get different keys (`c3-immich-shape`).

**Seven holes drop real paths today.** SPEC says the change rule "never hides one that can". Each repro lists a reachable outcome or arrow on no path:

| Repro | What happens | Fix (PR 1) |
|---|---|---|
| `hole-alias` | `const a = u; … a.admin = false`. `changeSites` (1106) marks `a`, not `u`. | A write to a field makes later reads of that field on any object new questions. |
| `hole-other-reference` | `demote(holder.user)` changes `u` when they're the same object. | Same rule. |
| `hole-unrelated-effect` | `if (await repo.isLocked(id))`, then `lockEverything()`, then the same check again. | An unseen effect makes later lookups new questions. This is owner question 1, which must be decided before PR 1. |
| `hole-loop-pass` | `if (x.a) return 'pre'; for (…) { if (x.a) return 'second-pass'; if (it === 'go') x.a = true }`. Identity counts only changes before the check (1499). | A check in a loop body counts changes anywhere in its innermost loop's body, including helpers and unseen calls made there. |
| `hole-truthy-vs-equal`, `hole-truthy-vs-null` | `edgeConstraint` keys `x` (values `true`/`false`, `paths.ts:90`) and `x === 'a'` (value `'a'`, line 78) as one variable. After `x === 'a'` yes, both answers of `x` are ruled out. | Truthiness gets its own key. A step box's literal also sets the truthiness it implies. |
| `hole-catch-in-helper` | `unseen` (446-451) only looks at calls written in the try block and treats repo helpers as seen. `JSON.parse` inside `load()` throws into the catch on a route that isn't drawn, and nothing is listed. | Look through helpers, including helpers that are listed, collapsed or cut off by depth or the budget. Any unseen call, `new` or `await` lists the catch. |
| `hole-step-assign-name` | A helper's widened local `mode` has step boxes `mode = 'b'`. `applyAssigns` matches display names (`paths.ts:116-125`), so they constrain the caller's own `mode`. | Until value identity, step boxes inside inlined helpers give no facts. |

**The walk can't carry facts out of helpers.** An `if`'s branches are built before its condition (342-344). An inlined helper's exits are fixed box ids built before the helper is walked (1243, 1352). Carrying facts in the walk would mean turning exits into continuations, and adding facts to the memo and inline cache keys (854, 1291). Those are the widening, combination-cap and caching interactions where past bugs sat. The pass sees helper boxes for free.

## Design

**Facts on arrows.** The chart has no cycles: loops are drawn as one pass, and all 52 charts confirm it. In order from the root, each arrow carries the facts known on it:
- what every arrow into its box agrees on (the weaker of their constraints);
- plus its own answer, using `edgeConstraint` with truthiness keyed on its own;
- plus a step box's literal assigns, from the entry function only.

The pass reuses `Constraint`, `assume` and `step` from `paths.ts`, so it rules out only what path listing rules out. The chart's feasible paths are the same before and after the pass, which tests check.

**Redirecting.**
- If the facts on an arrow into a box leave one answer, the arrow goes straight to that answer's target.
- If they leave **no** answer, the arrow is kept, and extraction fails loudly, as the integrity check does. A wrong fact got in.
- A box nothing points at any more is dropped. A shared box keeps its arrows for the branches that don't decide it.
- Each redirect is recorded: `settled: [{ from, edge, box, answer, because, via }]`. This bumps the raw chart's `schemaVersion`, and charts without it read as unsettled.
- The pass is one pure function in `src/graph/settle.ts`, about 300 lines.

**Where it runs.** On every `extractWidened` result in the budget loop (150, 158, 162), before boxes are counted, so the budget compares settled sizes.

**Where facts must stop:**
- **Loops.** Facts from a box don't reach boxes outside its innermost loop. A box's `loop` tag is the loop chain, so outside means a shorter chain. Charts have no arrow for running a loop zero times.
- **Catches.** A catch that something unseen can throw into starts with no facts, using the widened `unseen` from PR 1. The extractor marks its first box.
- **Volatile calls** (1402) teach nothing beyond their own box.

**After a redirect, verify and saved tests change:**
- Path ids change, because the path signature hashes the steps. Saved tests are rerun and matched to the new paths by the route they took, so they aren't rewritten.
- Completeness probes on a return the pass made unreachable report it as settled, with the reason, not as "not reached".

**Conditions as trees (PR 4).** Each box stores its condition as `and`/`or`/`not` over atoms:
- `X === lit` and `X !== lit`;
- `X == null`;
- `typeof X === 'lit'`, an equality on `typeof X` (today `typeof v` fails `isAtom`, `paths.ts:77`);
- truthiness;
- anything else, which is opaque.

Evaluation uses three values: yes, no, unknown. The implications between keys are part of soundness, not a nicety. Today's single key is unsound (hole 5). PR 1's split is sound but weaker. PR 4 adds back only implications unit-tested against real JS values: `X === 'a'` implies X is truthy; `X === null` implies it's falsy; `typeof X === 'function'` implies it's truthy.

**Value identity (PRs 6–7).** Each `Value` and `Arg` gets a `term`: the expression with every name replaced by what it holds, built from:
- entry parameters and `this`;
- module constants;
- literals;
- property reads, carrying the version of the object read;
- lookup calls, keyed by callee and argument terms;
- a fresh term for each volatile call;
- `local(decl, call)` for a helper's unknown locals.

A `const` holding a call is a snapshot of the call where it was declared. `text()` stays for display only.

What changes: terms are set in `valueFor`, `value`, `declare`, `changed`, `widened`, and the parameter and receiver binding in `tryInline`. Then the shape key (1395), `valueKey` (1766), `argsKey` (1284), path keys and label validation switch to terms, and `identityOf` and the key plumbing go. Outcome ids keep `valueIdentity` (1193). After that, step-box assigns in helpers carry terms and can be facts again.

## The 13 charts that fail only on dead arrows

| Chart | Unblocked by | Notes |
|---|---|---|
| PostHog `endpointFor` | 2 | All 6 redirects found by the throwaway, on today's keys. |
| Vendure `onTransitionStart` | 2 | 3 redirects found. `currencyCode` after the helper sets it needs equality between two values, which isn't planned. |
| Cal.com `preprocess` | 2, 4 | `typeof` atoms, and step boxes that set an object. |
| Outline `documentUpdater` | 4 | `publish \|\| …` after `publish && cId` yes. |
| PostHog `capture` | 4, maybe 8 | `a \|\| b` after step boxes. |
| Documenso `validateNumberField` | 4 | `foundRegex && …` after a step. `maxValue < minValue` against `minValue > maxValue` needs `<`/`>` (later). |
| Rocket.Chat `getRoomWithOptionToJoin` | 5 | Destructured defaults. |
| better-auth `resolveBaseURL` | 5 | `undefined?.headers…` folding. |
| Immich `checkAccess`, `BaseService.checkAccess` | 6–7 | `request.ids` is `idSet`. |
| Documenso `completeDocumentWithToken` | 6–7, then step terms | The step box's value is the checked value. |
| Rocket.Chat `setUsernameWithValidation` | 4, 6–7 | One arrow needs equality between two values. |
| LaunchDarkly `validateFileOverrideSourceOptions` | not planned | Needs what a helper without branches returns (`Function.is`). |

## PR sequence

Each PR is mergeable alone and gated by the correctness check (A1–A3 first).

1. **The seven holes** (~300 lines). Tests: the seven repros list their paths. Measure box counts on the 60 charts, since more distinct boxes merge less (1395).
2. **Settle pass** (~300 lines plus tests), off by default until owner question 3 is settled.

   Tests:
   - redirects: `c1a`, `c1b`, `c3b`, `c4a`, `c5`, `c7`, `endpointfor-shape`;
   - no redirect: every hole repro, `c2`, zero-iteration loops, volatile calls, r1–r9;
   - no answers left fails loudly;
   - feasible paths are unchanged;
   - running it twice changes nothing.

   Also: saved-test migration, completeness reporting settled returns, and the schema bump. Rerun the 60 charts.
3. **Correctness check: probing bypassed boxes** (below), if A1–A3 don't cover it.
4. **Conditions as trees, with the implication rules** (~250 lines). Test shapes: `capture`, `documentUpdater`, Outline's switch arm, `typeof`.
5. **Bind what calls pass** (~150 lines): destructured defaults, and partly known conditions. Repros: `c4b`, `c4c`.
6. **Value terms, computed but not used** (~400 lines). A test compares the old identity's equalities with the terms' across every test and repro. Every difference is reviewed.
7. **Terms as identity** (~300 lines changed, net fewer). Test: `c3-immich-shape` settles; r1–r9 and every existing test still pass.
8. **Optional:** copy up to N boxes past a join so a deciding branch reaches its check.

## Risks, and what the correctness check must catch

The main risk is hiding a live path. Once the pass runs, a bad merge or a wrong fact removes a box or outcome from the chart itself, not just a path from the list. It can happen through:
- two values sharing a key (holes 5 and 7 show it isn't hypothetical);
- a fact outliving a change the model misses (holes 1–4);
- a catch or loop entry the chart doesn't draw (holes 4 and 6);
- a wrong implication rule.

Smaller risks:
- PR 1 can add boxes;
- vanished outcomes surprise readers, which is owner question 5.

On top of the design in `docs/design/correctness-check.md`:
- **Keep the strict gate.** A PR that removes an arrow not triaged dead fails, untested ones included. The unit for this is the redirect: its arrow, box and answer, in its call context. Whether untested redirects may ever land is owner question 2.
- **Probe bypassed boxes.** Every box in `settled` gets a probe, matched by the redirect's own `via`, so a shared helper box answers from the right call. Any run through a redirected arrow where that box answers otherwise fails. Loop and shared helper boxes aren't exempt.
- **Inputs:**
  - the same object reached through two references;
  - loops run zero, one and two times (multi-pass runs need judging for `hole-loop-pass`);
  - stubs that throw into catches, including from inside helpers;
  - stubs where an unrelated call changes a lookup, matching the rule picked in owner question 1;
  - helpers with omitted and destructured arguments;
  - long arguments shown by name.
- **Static checks on every chart:** feasible paths are unchanged, a second run changes nothing, the chart passes the integrity check, and no arrow is left with no answers.

## Why not a solver, and later uses

A solver doesn't fix shared boxes, since it still deletes arrows. It needs value identity, since label text is no longer written in entry parameters (by-name display, PR #16). Its JS translation (truthiness, `NaN`, coercion, `?.`) is a new place for unsound rules.

Two later uses are worth keeping in mind:
- a solver's satisfying model as targeted inputs for reaching one specific arrow, in the correctness check or verify's test writer;
- a range domain for `<` and `>`, which `validateNumberField` needs.

## Open questions for the owner

1. **Before PR 1:** if code calls something Vantle can't see, should a lookup asked again afterwards (`repo.isLocked(id)`) count as a new question? I recommend yes. Today it doesn't, and that hides paths (`hole-unrelated-effect`). The cost is more listed paths in service code. The correctness check's stubs must follow whichever rule you pick.
2. **May an untested redirect land,** or must every redirect be confirmed by runs or by a person? I recommend confirmed only, which is the check's current rule. Untested redirects are reported, not applied.
3. **Is the pass on by default?** I recommend off until the corpus confirms every redirect, then on.
4. **Types as facts.** Should a written `default`, or a `never` guard, drop when a literal-union type plus earlier checks cover every member (`c6`)? I'd say no. People write those for bad data.
5. **Show what the pass removed?** I recommend recording every vanished check and outcome in the raw chart, and listing vanished outcomes with the chart, like "not charted".
6. **Copying to settle shared boxes.** Decide after PR 2's numbers.

# No-user tests: extractor coverage

This test needs no one else's time. The protocol below was written and committed before it ran, so the results can't move the bar.

> **Public version.** The original write-up had a second test, on agent-written pull requests in a private repository. Its data isn't public, so that section, its results and its departures are left out here. Test A below is unchanged apart from that.

## Test A: extractor coverage

**Assumption tested** (from the first product review): the extractor covers enough real TypeScript. Below 50% usable, the long tail owns the roadmap.

**Repos.** These 20 popular TypeScript repos, fixed before any run. None was used to develop Vantle; GrowthBook, CASL and the Flagsmith and Unleash Node clients are excluded.

| | Repo | | Repo |
|---|---|---|---|
| 1 | novuhq/novu | 11 | unkeyed/unkey |
| 2 | calcom/cal.com | 12 | Infisical/infisical |
| 3 | medusajs/medusa | 13 | logto-io/logto |
| 4 | vendure-ecommerce/vendure | 14 | better-auth/better-auth |
| 5 | payloadcms/payload | 15 | PostHog/posthog-js |
| 6 | directus/directus | 16 | launchdarkly/js-core |
| 7 | outline/outline | 17 | bluesky-social/atproto |
| 8 | twentyhq/twenty | 18 | immich-app/immich |
| 9 | formbricks/formbricks | 19 | n8n-io/n8n |
| 10 | documenso/documenso | 20 | RocketChat/Rocket.Chat |

**Package.** The default branch, shallow-cloned, with no dependencies installed. The package is the folder with a `tsconfig.json` that holds the most non-test `.ts` files, with `.ts` files outnumbering `.tsx`. The rule is mechanical, so I don't choose the code. If its `tsconfig.json` can't be loaded, the next-largest package is used, and that's recorded.

**Functions.** `vantle scan` on that package, top three rows. Test files, generated files and anything under `node_modules` or `dist` are skipped. This is what a new user would see first. It isn't a sample of the functions they would mark.

**Usable chart.** All of these must hold:
1. `extract` finishes without an error and within 60 seconds.
2. The chart has between 2 and 50 decision boxes.
3. At least 90% of the boxes have a label of 160 characters or less.
4. A reviewer reading the source agrees the chart is faithful. No arrow goes somewhere the code doesn't. No check that changes the outcome is missing, unless the chart's "not charted" list names it.
5. The same reviewer agrees the chart shows the function's main decision. A chart that is mostly "not charted", or that charts only argument checks around a decision it doesn't show, fails.

The reviewers are fresh agents with the source, the chart (as Mermaid, with the raw box code) and the "not charted" list. Each verdict comes with a reason category, so the failures say what to build.

**Bar.** At least 50% of the 60 charts usable means go: extraction is broad enough, and the roadmap stays as planned. Below 50%, the top failure categories become the next work, ahead of `vantle diff`.

## Known biases

- No dependencies are installed, so types from outside the repo are unknown. A real user would have them installed.
- Labelling isn't tested. It needs an API key, and the review found extraction to be the risk.

## Results

The test ran on 2026-10-22, on Vantle at commit `5525a81` (in the private history before this public snapshot). The scripts are in `experiments/`. Reviewer verdicts and the scoring scripts are in `docs/experiments/no-user-tests/`.

**In short:** Test A misses its bar. 27% of charts are usable, against a bar of 50%. Worse, 13 of the 31 charts that look fine on size and labels are wrong. Under the bar, its top failures become the next work, ahead of `vantle diff`.

### Test A: 16 of 60 charts usable (27%)

**Below the 50% bar.** 11 of the 20 repos have at least one usable chart, and only LaunchDarkly has three. Leaving out the three repos where the package problems weren't about the charts, it's 16 of 51 (31%). For Twenty, the scan didn't finish. For atproto, no package with logic would load. For logto, the rule picked a translations package.

| Repo | Usable (ranks 1–3) | Main reason, by rank |
|---|---|---|
| novuhq/novu | . Y . | long labels, —, missing check |
| calcom/cal.com | . Y Y | too big, —, — |
| medusajs/medusa | . Y Y | wrong arrow, —, — |
| vendure-ecommerce/vendure | . Y . | too big, —, missing check |
| payloadcms/payload | . Y . | not charted dominates, —, missing check |
| directus/directus | . . Y | not a decision, missing check, — |
| outline/outline | . . . | missing check, not a decision, long labels |
| twentyhq/twenty | . . . | scan didn't finish in 40 minutes (all three) |
| formbricks/formbricks | . . Y | too big, wrong arrow, — |
| documenso/documenso | . . . | missing check, missing check, long labels |
| unkeyed/unkey | Y Y . | —, —, not a decision |
| Infisical/infisical | . . . | too big (all three) |
| logto-io/logto | . . . | not a decision (the rule picked the translations package) |
| better-auth/better-auth | . . . | missing check, long labels, missing check |
| PostHog/posthog-js | . Y . | wrong arrow, —, not a decision |
| launchdarkly/js-core | Y Y Y | |
| bluesky-social/atproto | . . . | 55 packages wouldn't load; the first that did has no logic |
| immich-app/immich | . . . | wrong arrow (all three) |
| n8n-io/n8n | . . . | too big (224–838 boxes, all three) |
| RocketChat/Rocket.Chat | . Y . | missing check, —, long labels |

**Main reasons across the 44 unusable charts:**

| Reason | Charts |
|---|---|
| Missing check | 10 |
| Too big | 9 |
| Not a decision | 9 |
| Wrong arrow | 6 |
| Long labels | 5 |
| Scan didn't finish | 3 |
| Not charted dominates | 1 |
| Couldn't load | 1 |

Logto and atproto each have only two scan rows. Each missing third row counts as unusable: "not a decision" for logto, "couldn't load" for atproto.

**The worst finding is charts that look fine but are wrong.** 31 charts passed the size and label checks, and 13 of them are unfaithful. A missing check or a wrong arrow in a chart that looks clean is the failure Vantle exists to prevent.

**What failed, in the order to fix it.** This order isn't by count. Wrong arrows come first because they break the fail-closed precondition. "Not a decision" (9) is about which functions `scan` puts first, so it's item 5. The examples come from the reviewers' evidence, with file and line references in the verdict files.
1. **Wrong arrows.** These break the fail-closed precondition, so they come first.
   - **After the "too many combinations" limit, "no" arrows skip later checks.** Medusa `prepareLineItemData`: after "custom price?" says no, the arrow goes straight to the return, past the tax-line, adjustment and cart checks. The "not charted" list then names checks that are drawn on other paths. PostHog's `capture` and `_init` do the same.
   - **Outcomes with the same return text are merged when their variables differ.** Immich `checkAccess`: the Editor-only album permissions point at the Viewer outcome, so the chart says viewers can update albums.
   - **Smaller cases.**
     - Outline: a destructured `await Promise.all` is drawn as a condition that is always false.
     - Formbricks: a switch on a literal fans out to every case.
     - Payload: a loop has no path for running zero times.
2. **Helpers that throw are dropped without a word.** Calls written as statements aren't drawn or listed as not charted, and the result depends on them. Examples:
   - `assert*`, `validate*` and `enforce*` helpers: Novu, Vendure, Documenso, Infisical;
   - `this.` private checks: Directus `updateMany`;
   - static methods in an imported class: Outline;
   - awaited calls written with `!` or destructured: Payload;
   - a throw inside a transaction callback: Documenso;
   - the permission checks in Rocket.Chat's `validateUserEditing`;
   - better-auth's `assertHasProtocol`.
   
   Some throwing calls are even listed as effects where "both sides end the same way".
3. **Size.** After a step that only has side effects ("order changed at line N"), every later check is drawn again on each branch. Vendure's `onTransitionStart` reached 60 boxes when about 35 distinct checks would cover it. Infisical, Formbricks and Payload have the same problem. Merging identical subgraphs downstream would fix the Vendure-type charts. Four of the nine too-big charts are 1,800–2,100-line dispatchers (n8n ×3, Cal.com's `handler`): those need `scan` to rank them lower, not a smaller chart. Validators that collect errors in a list (Infisical #1, Documenso #3) need to be drawn as a checklist.
4. **Labels.** Local variables are replaced by their whole initializer, and helpers are drawn as if their arguments were unknown. One better-auth label is 2,683 characters long.
5. **`scan`'s ranking.** It puts giant orchestrators, dispatch switches and wrappers first, and lists a wrapper and the function it wraps as two rows (Immich). On Twenty's server package (12,255 files), scanning isn't slow because of size: the first 15,700 functions take under 3 minutes. It then stalls on one small function, `updateParentStep` in `workflow-version-step/utils/insert-step.ts`, which has about four branches and ran over four minutes without finishing. The cause isn't known yet. A runaway through the helpers it inlines is likely. A per-function time limit in `scan` would stop one function from blocking the rest.
6. **Projects whose tsconfig only lists references.** atproto's 55 largest packages failed to load this way. The next one, `services/ozone`, loaded, but it holds only startup code.

**What worked.** Small, plain decision functions came out clean: if/else chains, early returns and small inlined helpers. Examples are all three of LaunchDarkly's charts, PostHog's `endpointFor`, Unkey's `matchContentType` and `retryIntervalFromResponse`, Cal.com's filters and Medusa's payment status.

### Departures from the protocol

- **Packages:** the script first stopped after five packages that wouldn't load. Only atproto was affected, and it was rerun trying every package, as the protocol says. Twenty's scan didn't finish within 40 minutes, so its three charts count as unusable.
- **Package rule for logto:** the rule picked `packages/phrases` (translations). As a side check, not counted, its core package's top three are a Zod-to-Swagger converter and two URL-wildcard matchers. Those still aren't the sign-in decisions a user would chart, and they weren't reviewed. So a better package choice wouldn't obviously have changed logto's result: `scan`'s ranking is part of the problem.
- **Who judged:** fresh reviewer agents, not people. Each verdict file has the evidence, so any call can be checked. Five reviewers judged Test A, and a last agent checked this write-up against the data.

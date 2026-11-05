# Chart size, round 1: rerun of the coverage test

The [first extractor fixes](extractor-fixes-1.md) made charts more often right and more often too big: 18 of the 60 coverage charts had more than 50 boxes. This round goes after size, then re-measures on the same 60 charts. Fresh reviewer agents judged every chart that changed and now passes the size and label checks. The data is in `no-user-tests/rerun-2/`, and `python3 rescore.py` there reproduces every number below.

## Result

| | Before (extractor fixes 1) | After |
|---|---|---|
| Pass the size and label checks | 26 | 39 |
| Too big (more than 50 boxes) | 18 | 9 |
| Labels too long | 7 | 3 |
| Usable, counting arrows no execution takes as noise | 17 | 23 |
| Usable, counting those arrows as wrong | not measured the same way | 10 |
| Of the 39 that pass the checks: fail only on such arrows | | 13 |

**In short: size is mostly fixed, and dead arrows are now the main blocker.** Under the strict reading, 13 of the 39 charts that pass the checks fail only on arrows no execution can take.

**Two readings.** Some arrows are dead: an earlier check, a step box or the call's arguments already decided the check, but the chart still draws both arrows. The original brief's words make those wrong arrows, and this round's brief said so explicitly. Earlier rounds mostly treated them as a readability problem. The last round counted them as wrong only in two charts.

That's why the strict count looks like a drop (16 to 10): six of the seven charts that "stopped being usable" have the same structure as before. They have the same path counts, or one copy fewer, and fail only on dead arrows they already had. The seventh is formbricks `processSingleFilter`, also unchanged. It fails on dead arrows and on a throw from a recursive helper that isn't listed. The fair comparison with the last round is the lenient reading, **17 to 23**. Under it:
- Outline `documentUpdater`, Vendure `onTransitionStart`, better-auth `resolveBaseURL` and Rocket.Chat `getRoomWithOptionToJoin` became usable after being too big.
- Rocket.Chat `setUsernameWithValidation` became usable after having labels that were too long.
- better-auth `toOpenApiSchema` became usable outright.

## What changed in the extractor

1. **Shared checks are drawn once after every join that copies too much.** When branches that set variables differently rejoin, the checks after them were drawn once per branch. The extractor widened one such join per re-extraction, at most 8 times. A run of `if`s that each set a field ran out of re-extractions first, and later checks were drawn once per mix of fields: Outline's `documentUpdater` had 129 boxes for 27 checks. Now every such join is widened in the same pass, up to 40 passes, and Outline's chart has 21 boxes.
2. **A box budget.** A chart over `--max-boxes` (default 50) follows helpers less deep, using the deepest depth that brings it under. Past it, each helper is one box, a warning says so, and a helper that can throw is listed. A chart too big even at depth 1 is drawn in full.
   - **Brought under 50 by the budget:** better-auth `resolveBaseURL` (60 to 46), Novu `tryHandleAction` (59 to 35), Vendure `modifyOrder` (73 to 35) and Payload `getFileHandler` (53 to 50).
   - **Not checked:** the search skips depths between full depth and depth 1 when depth 1 doesn't fit. Box counts almost always fall with depth, so skipping them saves an extraction per depth on the biggest charts.
3. **Long values are shown by name.** An inlined helper's parameter used to be replaced by the caller's whole argument, so one label could repeat `(false ? users : [(await Users.findOneById(...)), ...users])` three times.
   - Now an argument over 60 characters leaves the parameter's name. A variable holding a value over 60 characters is shown by name too (the limit was 160).
   - The argument's text becomes its key, so calls with different arguments stay different questions.
   - Immich's `{ sharedLink: auth.sharedLink, permission, ids: (...) }.ids.size === 0` now reads `request.ids.size === 0`.
4. **Label fixes found by the reviews:**
   - A constant whose source changes before it's read keeps its name. Vendure's refund check read `(order.totalWithTax - order.totalWithTax) < 0`.
   - A substituted ternary keeps its parentheses.
   - A forgotten value no longer gets a `path = path` step box at every later join.

A fresh-context code review of the changes found one class of serious bugs, now fixed. Once a long argument was shown by name, its key was the only thing telling two calls apart. Several places lost the key: a receiver shown as `this`, a value the helper changes, a join inside the helper, an expression passed on, and a default parameter. In those places, two different objects read as one question and paths were lost. It also found that checking for code changes re-extracted with default options, so a chart made with `--max-boxes`, `--depth` or `--max-inline` read as "code changed". Raw charts now record their options. 178 tests pass, up from 161.

## What's left, in order

1. **Dead arrows** (13 charts fail on nothing else). The extractor doesn't carry what a path has already established:
   - a check made earlier on the same value;
   - a literal a step box set;
   - a check the caller made before an inlined helper (Immich's 22 helpers each re-check `request.ids.size === 0`);
   - a constant or default argument passed in (PostHog's `_prepareEndpoint` re-checks `target === 'ui'`; Rocket.Chat's destructured defaults);
   - a type a guard narrowed;
   - a switch case already ruled out.

   This is the next work. It should turn most of those 13 into usable charts.
2. **Missing checks** (6 charts), mostly already on the list:
   - a helper's throws reached through a call inside another helper's arguments or delegate (Documenso `signFieldWithToken`, Vendure `modifyOrder`, better-auth `handleOAuthUserInfo`);
   - a helper that changes an argument a later check reads (Novu);
   - `provisionVanityInbox` (Novu);
   - a loop that builds a collection with `continue` filters, dropped without a note (Vendure `resolveRefundTargets`);
   - a recursive helper that can throw, not listed (formbricks).
3. **Other wrong arrows:**
   - a throw inside an `async` helper drawn as a throw out of the caller, though the caller's `.catch` handles it (Outline `handlePaste`);
   - a loop drawn as one pass with no arrow for running zero times (Payload `getFileHandler`);
   - Directus `updateMany`'s catch that stores the error for a later rethrow.
4. **Still too big** (9): three Infisical policy and certificate functions, Cal.com's 2,000-line `handler`, formbricks `evaluateSingleCondition`, Payload `sanitizeField`, and n8n's three dispatchers, which still crash with a stack overflow. Their own bodies are bigger than 50 boxes. They need the ordered-rule and scenario views (plan step 4), or for `scan` not to pick them.
5. **`scan`:** 8 charts aren't decisions. Immich's `BaseService.checkAccess` is a one-line wrapper whose chart is node for node the same as `checkAccess`.

## How it was judged

- **Extraction.** The 60 functions were re-extracted from the same commits (`experiments/rerun.ts`).
- **Who was reviewed.** Every chart that passes the size and label checks and changed visibly since the last round was judged again by fresh reviewer agents: 32 charts, six agents. Visible changes are box labels, arrows and the not-charted list. The reviewers used the original brief plus a note on what's new (`review-brief.md`), and were blind to earlier verdicts. Two of them listed the output folder while checking their own files, after writing them, and saw other files' one-line summaries. Neither changed a verdict afterwards.
- **What happened after the review.** Two label fixes landed after the review. They changed labels only, in 9 reviewed charts, with no box, arrow or path count changing. Only Vendure `modifyOrder`'s verdict hinged on a label, and it was judged again (`rereview/`). It now fails on dead arrows and a throw that isn't listed.
- **The rest.** Charts that didn't change keep their verdict. Charts over the size limit count as unusable without review.

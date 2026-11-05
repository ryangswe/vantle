# Extractor fixes, round 1: rerun of the coverage test

The [no-user tests](no-user-tests.md) found Vantle's charts usable 27% of the time, and 13 of the 31 charts that looked fine (size and labels) were wrong. This round fixes the wrong ones first, then re-measures on the same 60 charts: the same functions, re-extracted, with fresh reviewer agents judging every chart that changed. The data is in `no-user-tests/rerun-1/`, and `python3 a-rescore.py` there reproduces every number below.

## Result

| | Before | After |
|---|---|---|
| Usable | 16 of 60 | 15 of 60, or 17 counting dead arrows as noise (below) |
| Charts that pass the size and label checks | 31 | 26 |
| Of those, unfaithful | 13 (42%) | 7 (27%) |
| Main reason: wrong arrow | 6 | 2 |
| Main reason: missing check | 10 | 4 |
| Main reason: too big (more than 50 boxes) | 9 | 18 |

**In short: charts are much more often right, and more often too big.** The usable count barely moved, because the fixes traded wrong charts for big ones.

**Dead arrows.** Both remaining wrong-arrow charts (PostHog `capture`, Cal.com `preprocess`) fail on the same thing: a check whose answer an earlier check already settled still gets both arrows, and one of them is an arrow no execution takes. The last review round counted that as a wrong arrow, which is what the brief's words say. Earlier rounds treated dead arrows as a readability problem. Counted that way, both pass, making 17 of 60. Either way, carrying settled answers forward is now on the list below.

- **Became usable:** Immich's three access checks (they were wrong: the chart said viewers could update albums) and Documenso's `completeDocumentWithToken` (its guards were missing).
- **Stopped being usable:**
  - Rocket.Chat `getRoomWithOptionToJoin`, 33 → 57 boxes;
  - Payload `checkFileRestrictions`, 50 → 104;
  - Vendure `modifyOrder`, 27 → 77.

  The new boxes are checks the old charts dropped (throwing guards, catch bodies, checks the combination limit erased) and the copies those checks multiply through.
- **Cal.com `preprocess`:** dead arrows (above).
- **Novu `isExistingConversationEventBlocked`** was judged usable in the first run and unfaithful on re-review. It had changed only in its duplicates. The re-review found a helper that sets `message.isMention`, which a later check reads, neither drawn nor listed. That's a reviewer difference, not a regression.

## What changed in the extractor

1. **The combination limit no longer drops checks.** Past the limit, both sides of an `if` could widen to the same values, so the check vanished as "both sides end the same way". Now a step box shows what each side set (Medusa, PostHog).
2. **Returns that read the same but hold different values are different outcomes** (Immich). Outcome ids use places in the function, not character offsets, so they hold when unrelated code moves.
3. **Helpers that can throw are drawn.** This covers calls anywhere they always run: as statements, in arguments, in initializers, in returns, and in `if` and `switch` subjects. Examples are `assertX(u)`, `this.validate(u)`, `Guard.check(u)`, `const { user } = await load(id)`, `find({ where: build(id) })` and `return String(assertPos(x))`. Their throws become outcomes, and everything else continues. A helper that would add more than 10 boxes is listed instead. Whether a helper can throw now looks at every call it makes. It no longer treats a depth cut-off or recursion as "can't throw".
4. **Throws inside a `try` go into the `catch`,** with the caller's variables, and the catch is drawn and carries on as written. A catch that only rethrows keeps each throw its own outcome. The catch is still listed unless a drawn throw reaches it and nothing unseen in the try (a call outside the repo, `new`, `await`) could throw into it. A `finally` that decides something is listed.
5. **What can't be drawn is listed:**
   - a check whose sides end the same but set a variable used later;
   - a helper that throws only from a callback, or only on some paths (`a && f()`);
   - a callback that can throw;
   - a returned or checked call too big to draw, whose throws come before its result.
6. **Fewer copies.**
   - A call to a repo method that doesn't change `this` no longer marks it changed.
   - A change that no later box can tell apart settles where it's made, with its own step box, so the copies of later checks merge.
   - PostHog's `capture` had drawn one check seven times.
7. **Labels keep their parentheses** after `await` and `as`.

GrowthBook still verifies 22 paths and 56 of 57 arrows, and the Slack fixture's chart and drift checks are unchanged. A fresh-context review of the code found ways throws and catches were still hidden, including one where verify reported a path through a hidden throw as verified. All are fixed, each with a regression test (161 tests).

## What's left, in order

1. **Size.** 18 charts are too big; 4 of them are 1,800–2,100-line dispatchers that `scan` shouldn't rank first. The rest are faithful charts of big decisions, still padded by copies:
   - helpers drawn once per call site with different arguments;
   - branches an earlier check already decided, which are still drawn;
   - values whose contents differ only in ways no box reads.
   
   This is the next work, with the ordered-rule and scenario views (plan step 4) as the other half: a 60-box decision may need a different view, not a smaller chart.
2. **Remaining wrong or missing.** Seven charts that pass the size check are unfaithful:
   - **Settled answers aren't carried forward.** This leaves dead arrows (PostHog, Cal.com). It needs a repeated condition resolved over unchanged reads, and `typeof` narrowing and literal values carried into helpers.
   - **Value-level `?:`.** A ternary whose result goes into the returned value is neither drawn nor listed (Medusa's `requiresShipping`).
   - **Helpers that change an argument.** They aren't drawn when a later check reads what they set (Novu's `restoreMissingMentionFlag`).
   - **Throws two calls deep inside a helper's callback** (Directus's `applySort`), and a returned call reached through a path the last fix doesn't cover (Novu's `provisionVanityInbox`).
   - **Checks inside callbacks that shape the returned value** (Directus's `sortRecords.map`).
   - **A `catch` that writes the error into state an opaque call throws later.** Directus `updateMany` is now drawn faithfully, but as one outcome, so rejected and accepted updates look alike. That is "not charted dominates", not a wrong arrow.
3. **`scan`'s ranking.** It puts wrappers, initializers, serializers and dispatchers first. Eight unusable charts aren't decisions at all.
4. **Twenty.** One small function, `updateParentStep`, stalls `scan`. A per-function time limit would stop it blocking the rest.

## How it was judged

The 60 functions were re-extracted from the same commits (`experiments/rerun.ts`) after each set of fixes. Each round, fresh reviewer agents judged every chart that passed the size and label checks and had changed since the last round. They worked blind to earlier verdicts, using the original brief plus a note on what's new. That was 17 charts, then 7, then 6, then 9. After the last round, one more fix landed (throws of returned calls), and it changed none of the charts that pass the size check. Charts that didn't change kept their verdict. Charts over the size limit count as unusable without review.

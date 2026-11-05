# Brief: judge extracted decision charts (Vantle, Test A)

Vantle is a TypeScript tool that turns a function's decision logic into a flowchart. It works by static extraction, with no AI. It inlines the helpers it can see, and lists the code it can't draw under "not charted". We're measuring whether its charts are usable on real repos. The protocol is in `docs/experiments/no-user-tests.md` (Test A). Read the Test A section first. Your verdicts decide its bar, so be strict and honest; nobody wants a flattering result.

## Your inputs, per repo

- Clone: `<scratchpad>/nouser/repos/<repo>` (shallow, default branch, no dependencies installed).
- Results: `<scratchpad>/nouser/a/<repo>/`
  - `summary.json`: the package used, and for each of the top three scan rows: file (relative to the package), line, boxes, paths, label lengths, timing, and `mechanical` (criteria 1–3 of the protocol).
  - `chart-N.md`: the chart as Mermaid, with the not-charted list.
  - `chart-N.json`: the raw flow. `nodes[].rawLabel` is the box's code, and `edges` are the arrows. `scope` lists the functions drawn inline. `notCharted` lists code the chart says it can't show.

`<scratchpad>` was the reviewer's working folder (path removed for publication).

## What to judge, per chart

Read the function's source and the helpers in `scope`, then compare them with the chart.

1. **faithful** (yes or no): every arrow goes where the code goes, and no check that changes the outcome is missing, unless "not charted" names it. A missing check that only changes a side effect counts as missing only if the function's result depends on it. Boxes merged or reworded are fine if the logic is right.
2. **mainDecision** (yes or no): the chart shows the decision this function exists to make. It fails if the chart is mostly "not charted", if it shows only argument checks or plumbing around a decision it doesn't draw, or if the function isn't a decision at all (glue, UI wiring, a big switch of handlers whose real work is elsewhere).
3. **readable** (yes or no, a note only): could a reviewer follow it? This isn't a criterion; criteria 2 and 3 already cover size and label length mechanically.

**usable** = `mechanical` from summary.json AND faithful AND mainDecision.

Pick one **category** for the main reason when usable is false. Use `none` when it's usable.
- `extraction-error`: it crashed, or the function wasn't found.
- `too-big`: more than 50 boxes.
- `long-labels`: fails the 90%-short rule.
- `missing-check`: a check the outcome depends on is missing and isn't listed.
- `wrong-arrow`: an arrow goes somewhere the code doesn't.
- `not-charted-dominates`: the real logic sits in callbacks, loops, side effects or other code listed as not charted.
- `not-a-decision`: scan's pick isn't a decision function a user would chart.
- `other`: explain.

When several apply, pick the one that most needs fixing for the chart to be usable, and list the others in `alsoCategories`.

## Output

Write one JSON file per repo to `<scratchpad>/nouser/a-review/<repo>.json`, holding an array of three objects:

```json
{ "repo": "...", "rank": 1, "function": "Name", "mechanical": true, "faithful": true, "mainDecision": true, "readable": true, "usable": true, "category": "none", "alsoCategories": [], "evidence": "one or two sentences with file:line references", "fixHint": "what Vantle would need to change, if anything" }
```

Then end with a short report: one line per chart (repo, rank, usable, category), plus any pattern you saw across repos. Don't edit anything outside `a-review/`. Don't change Vantle or the clones.

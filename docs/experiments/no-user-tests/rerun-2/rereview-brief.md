# Brief: re-judge changed charts (Vantle, Test A rerun, size round)

Follow `nouser/review-a-brief.md` exactly, with these changes:

- **Inputs.** The charts are in `nouser/a11/<repo>/`, not `nouser/a/<repo>/`. They are the same functions, re-extracted after extractor changes. `summary.json` there has the new `mechanical` value. The clones in `nouser/repos/` are unchanged.
- **Scope.** Judge only the charts assigned to you. Every one passes the mechanical checks, so judge `faithful` and `mainDecision` carefully. Read the source of the function and of every helper in `scope`.
- **Blind.** Don't look in `nouser/a-review/` or any `nouser/a*-review/` folder. You're giving a fresh judgement.
- **Output.** `nouser/a11-review/<repo>.json`, holding an array with one object per chart you judged (not three per repo), in the same schema, plus one field described below (`deadArrowOnly`).

## What the extractor does now (read before judging)

- **Step boxes.** Boxes of kind `action` (shown with round corners) say what a branch set or changed before rejoining a shared part of the chart, such as `document changed (line 143)` or `found = false`. A step box isn't a check. Judge whether the arrows around it match the code. After a step box, later checks are drawn once for every branch that reaches them, so a check's label shows a variable's name (`room`, `path`) rather than its value on each branch.
- **Helpers drawn less deep.** When a chart would have more than 50 boxes, helpers more than N calls deep may be shown as one box each, with a warning in the chart saying so. A box like `inner(x)` or an outcome like `getBaseURL(...)` then stands for a helper whose checks aren't drawn. That's allowed. Judge whether the chart still shows the decision this function exists to make (`mainDecision`), and whether its arrows are right. A collapsed helper that can throw is listed under not charted.
- **Names for long arguments.** In an inlined helper, a parameter whose argument is over 60 characters keeps the parameter's own name (`members.length === 1`, `request.ids.size === 0`), and so does a variable holding a value over 60 characters. Read the helper's call site to see what it stands for.
- Throws from helpers, try/catch, and what's listed as not charted work as before: a helper that can throw is drawn inline with its throws as outcomes, or listed if it's too big; a throw in a `try` goes into the `catch`, which is drawn; code Vantle can't follow is listed under not charted.

## Arrows no execution can take

Sometimes an earlier check or step already decides a later check on some path, but the chart still draws both arrows there (for example, `found = false` on one branch, then a shared `found?` box with a yes arrow reachable from that branch). Count such an arrow as a wrong arrow, as the original brief says: an arrow that goes somewhere the code never goes. Then also set:

- `deadArrowOnly`: `true` if arrows like this are the only reason the chart is unfaithful (every other arrow and check is right), otherwise `false`.

Say in `evidence` which arrow it is and what decides it.

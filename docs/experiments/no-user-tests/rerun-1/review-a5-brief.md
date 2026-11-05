# Brief: re-judge changed charts (Vantle, Test A rerun)

Follow `nouser/review-a-brief.md` exactly, with these changes:

- **Inputs.** The charts are in `nouser/a5/<repo>/`, not `nouser/a/<repo>/`. They are the same functions, re-extracted after extractor fixes. `summary.json` there has the new `mechanical` value. The clones in `nouser/repos/` are unchanged.
- **Scope.** Judge only the charts assigned to you. Every one passes the mechanical checks, so judge `faithful` and `mainDecision` carefully. Read the source of the function and of every helper in `scope`.
- **Step boxes.** Charts may now contain step boxes (kind `action`), such as "this changed (line 7)". A step box shows what a branch changed before rejoining a shared part of the chart. It isn't a check. Judge whether the arrows around it match the code.
- **Throws from helpers.** A helper called as a statement that can throw is now drawn inline. Its throws are outcomes, and its other paths continue to the next statement. If it would add more than 10 boxes, it's listed under not charted instead. Check that the throws drawn are real, and that a listed helper really is listed.
- **Blind.** Don't look in `nouser/a-review/` , `nouser/a2-review/` , `nouser/a3-review/` or `nouser/a4-review/`. You're giving a fresh judgement.
- **Output.** `nouser/a5-review/<repo>.json`, holding an array with one object per chart you judged (not three per repo), in the same schema.
- **Also new.** Throwing helpers called inside a statement's arguments are drawn too, except under `?:`, `&&`, `||`, `??` or `?.`. A guard a `catch` handles, and a callback that can throw, are listed under not charted.
- **Also new.** A throw inside a `try`, or from a helper the `try` calls, now goes into the `catch`, which is drawn and carries on as written. The catch is still listed when the `try` calls code Vantle can't see into. A check whose sides end the same but set a variable used later is listed. A helper that throws only from a callback is listed.
- **Also new.**
  - Throwing helpers are drawn inside returns, `if` and `switch` subjects and every declarator. One that only runs on some paths (`a && f()`) is listed.
  - A helper's throw reaches the caller's catch with the caller's variables.
  - A catch that only rethrows keeps each throw its own outcome.
  - A catch is listed unless a drawn throw reaches it and nothing unseen in the `try` could throw into it.
  - A `finally` that decides something is listed.

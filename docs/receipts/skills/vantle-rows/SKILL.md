---
name: vantle-rows
description: Vantle's receipt, done by hand. Before a behaviour change or bug fix, propose example rows and wait for approval. After the work, a fresh subagent runs the rows and writes a receipt with evidence, test-tampering and scope flags. Use when the user says "vantle-rows", "rows first", "propose rows", or "write the receipt".
---

# vantle-rows (the receipt, done by hand)

This is the manual version of Vantle's planned receipt, used on real work to learn whether agreed rows catch anything and what they cost. The format is `docs/receipts/rows-template.md` in the Vantle repo; read it once.

Set `<rows folder>` to wherever you keep rows files, outside the repo being changed, so the agent doing the work can't edit them.

**Skip rows** for docs, renames, refactors with no behaviour change, setup and exploration. Tell the user you're skipping, and why.

## Before any code: `rows`

1. Propose 3–6 rows (situation → expected outcome → how it will be checked → kind `test` / `command` / `live`).
   - Include at least one row for something that **must stay the same**.
   - Use the user's words for the outcomes where possible.
2. Also declare:
   - **Scope:** the files or folders you expect to change;
   - **Checks:** the project's own commands that should pass (typecheck, tests, lint).
3. Write them to `<rows folder>/<yyyy-mm-dd>-<short-name>.md`, along with the repo, the current HEAD sha and the session name.
4. **Show the rows and wait for the user's OK.** Record the minutes spent and what they changed.
5. After approval, don't edit the rows file's Rows section. If a row turns out wrong, say so and propose a change, and add the approved change under "Row changes", marked v2.

## After the work: `receipt`

**Run this step in a fresh subagent that didn't write the code.** Give it the rows file path, the repo path, and the base sha. It must not change product code or tests. It may create temporary check scripts outside the repo.

The subagent:
1. **Runs** every `test` and `command` row, plus the declared checks.
   - Records each run: command, commit sha, clean or dirty tree, exit status, the last ~20 lines of output, and the time.
   - A row is **matched**, **mismatched** or **couldn't run**. Never use matched without a run.
2. **Lists `live` rows** as a checklist for the user, each with the exact steps. Status: not checked.
3. **Flags test tampering:** from `git diff <base>..HEAD` over test files, it lists any deleted test, any skipped test (`.skip`, `xit`, `@skip`), and any changed or removed assertion in a test that existed before the task.
4. **Checks scope:** lists changed files outside the declared scope.
5. **Writes the identity line:** commit, branch, tree state, runtime versions, and any flag or setting that affects the behaviour.
6. **Attaches any evidence from other tools** if the project has it (CI, e2e reports, linters). Label each item with **who judged it**: a deterministic run, an AI judge (name the model), or the user. An AI-judged pass is never shown as "matched".
7. Writes the receipt under "After done" in the rows file, **exceptions first**:
   - mismatches;
   - flags;
   - couldn't-run;
   - live checks left for the user;
   - then the matched rows.

   It also reports the agent's summary claims that no evidence supports, in one line each.
8. Appends a line to `<rows folder>/rows-log.md`.

Then tell the user the receipt's top lines (exceptions first) and the file path.

## Honesty rules

- **Reading the code is not evidence.** Only runs and the user's own checks are.
- **Don't fix anything during `receipt`.** Report it; the user decides.
- **If a check needs a live environment you don't have,** it's couldn't run or not checked. Never assume it passed.

# Example rows, written by hand

**Goal:** find out whether agreeing a few concrete examples before an agent starts catches misunderstandings or bugs, and what it costs. Nothing is automated yet.

**When to use rows:** only for tasks that change behaviour or fix a bug. Skip them for docs, renames, refactors with no behaviour change, setup and exploration. In the first trial, the aim was the next 10 eligible tasks across a few of the author's repos.

## How it works

1. **Ask for rows before the work.** Paste this at the end of your task prompt:

   > Before changing any code, propose 3–5 example rows for this task in the format from `docs/receipts/rows-template.md` in the Vantle repo (situation → expected outcome, with how each will be checked). Include at least one row for something that must stay the same. Write them to `<rows folder>/<date>-<short-name>.md`, show them to me, and wait for my OK. After I approve, don't edit that file; if a row turns out to be wrong, tell me and propose a change.

2. **Approve in one pass.** Change, delete or add rows as needed. The agent shows you rows; you don't have to type outcomes from scratch. In the TiCoder study (Fakhoury et al., 2024), half the participants typed a wrong expected value on one task, while checking shown rows worked better. Record how long this took and what you changed.
3. **Let the agent work.**
4. **Check the rows yourself after it says done,** or have the agent run the `test` and `command` rows while you watch the output. Mark each row.
5. **Fill in a log line** in `<rows folder>/rows-log.md`, so results can be counted later.

## Row file format

Copy this into `<rows folder>/<date>-<short-name>.md`:

```markdown
# <task in one line>

Repo: <name>   Session: <name or id>   Date: <yyyy-mm-dd>
Prompt (short): <what you asked>

## Rows

| # | Situation | Expected outcome | Check | Kind | Stays the same? |
|---|---|---|---|---|---|
| 1 | <e.g. a signed-in user opens a page they don't own> | <403, and the page body isn't sent> | <test file, command, or live steps> | test / command / live | no |
| 2 | <e.g. the owner opens their own page> | <200, same as before> | <…> | test | yes |

## Approval

- Proposed by agent at: <time>   Approved at: <time>   Minutes spent: <n>
- Rows I changed, added or deleted: <which, and why in a few words>
- Approved unchanged? <yes / no>

## After "done"

| # | Result | How I know | Notes |
|---|---|---|---|
| 1 | matched / mismatched / couldn't run / not checked | <command output, live check, screenshot> | |
| 2 | | | |

- Did any row catch something the agent's summary didn't mention? <yes: what / no>
- Did I find a problem later that no row covered? <yes: what / no>
- Would a row I *didn't* write have caught it? <the row, in one line>
```

## Result words

Use these exactly, so they can be counted later:
- **matched:** checked, and it behaved as the row says.
- **mismatched:** checked, and it didn't.
- **couldn't run:** the check itself failed (setup, flaky, missing environment). Not the same as mismatched.
- **not checked:** nobody checked it yet.

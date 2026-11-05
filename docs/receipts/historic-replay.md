# Historic replay: would agreed rows have caught past bugs?

This experiment tests the layer every other part of Vantle rests on. If an agent writes example rows before a task, and the rows are run after the agent says done, do they catch defects that "done" missed? And how many false alarms do they raise?

The protocol was written on 2026-11-03, before any run, so the results couldn't move the bars. The cases come from the author's private projects, so the case files, rows, checks and evidence records stay private. This page keeps the method and the results. The post [Making Vantle, part 1](https://raymondyang.dev/writing/done-is-doing-a-lot-of-work) tells the story in more detail.

## Method

The defect cases are past tasks where an agent said "done" and the author later found a defect that could be checked without a live environment. A case only counts if a commit exists that contains the defective "done" state. The control cases are behaviour-changing tasks from the same period that the author accepted, with no correction about that behaviour within 7 days. They measure false alarms. Controls were chosen before any rows were written.

A separate agent plays each role, so that knowledge can't leak between them.

1. The case builder sees everything. For each case it writes a blind file, which holds only the author's original request and the commit before the task, and a sealed answer file, which describes the defect and the fix.
2. The row writer sees only the blind file and a clone at the commit before the task. It writes 3–6 rows in the [row format](./rows-template.md), including at least one row for something that must stay the same. It is told this is a historical exercise, not that a defect exists, so controls and defect cases look the same to it.
3. The translator sees the rows and a clone at the "done" commit, but not the answer file or the fix. For each row it writes an executable check of what the row says. It must not run the checks or adjust them to pass. Rows that need a live environment are marked live and count as couldn't run.
4. The runner is a script, with no AI. It runs each check on the "done" commit and, for defect cases, on the fix commit. It records the command, commit, exit status and output.
5. The fidelity judge sees the rows and the checks, but not the results, and marks each check as faithful to its row or not. This is an AI judgement and is labelled as one. Unfaithful checks don't count as catches. The author spot-checks 5 of its verdicts.

A defect case is caught when at least one faithful row fails on "done", passes on the fix, and fails because of the defect the answer file names. A control raises a false alarm when a faithful row fails on the accepted commit. Each such failure is checked by hand, and if it turns out to be a real, unnoticed bug, it is reported as found rather than as a false alarm.

The bars were fixed in advance. The result is promising if rows catch at least 40% of the runnable defect cases, with false alarms on at most 2 of 10 controls, at a cost of at most $3 and 15 agent-minutes per case. The approach needs rethinking if rows catch 2 or fewer cases, or raise false alarms on 4 or more controls.

## Results

The pilot ran on 6 defect cases and 10 controls. By the bar set in advance, the verdict is to rethink.

| Measure | Bar | Result |
|---|---|---|
| Defect cases caught | at least 3 of 6 | 0 of 6 (0 of 5 without the one bug that predated its task) |
| False alarms on controls | at most 2 of 10 | 2 of 10, plus 2 real gaps found and 1 failure excluded as stricter than the request |
| Cost per case | at most $3 and 15 agent-minutes | 3–11 agent-minutes and 150,000–285,000 tokens; the harness didn't record dollars |

The plumbing worked. The runner got through all 96 row checks in about 6 minutes, and only 7 of them needed a live environment.

Every defect case had failing rows, but each failure was about something other than the bug, and it failed the same way on the fix. No check told the buggy version apart from the fixed one.

## What it suggests

These are inferences from a small sample, not results.

1. Rows written from the request cover the request, and these bugs sat next to it. Two bugs were one step downstream of the code the task changed, one was on a side path, one sat where two layers of the interface meet, one broke existing behaviour that should have stayed the same, and one predated the task.
2. Rows about what must stay the same need to come from the code's existing behaviour, not from the request. In one case the old help text promised the very behaviour the task broke. A step that lists what the changed code feeds into, and what it promised before, would plausibly have produced the missing rows. That is untested.
3. Rows should name the final observer, and checks should reach it. Both near misses were lost at a layer boundary. In one, a check confirmed that an update reached the server, but the bug dropped it one hop later, before it reached the viewer. The AI judge rated that check faithful, and the author overruled it.
4. Rows that nobody reviews invent detail, and invented detail makes false alarms. Both false alarms came from rows that added details the request never asked for. Striking those details is exactly what a person's approval is for.
5. Failing rows weren't a useful signal by themselves. Every defect case had them, and so did half the controls, but for the wrong reasons.

The "rethink" verdict applies to rows that an agent writes from the request alone, with no one reviewing them. It doesn't settle whether reviewed rows do better, which is the next test. It does say the receipt needs a source of rows beyond the request before it can catch this kind of bug.

## Limits

- The sample is pilot-sized. One case moves the catch rate by about 17 points.
- The judges' blinding was partial. Some translators' notes predicted outcomes, and judges could read them.
- For some cases, the check that no existing test was edited was done by reading the translator's diff rather than by the runner. In one control, an existing assertion was edited and that check didn't flag it.
- It doesn't test maps above the code at all. No map was drawn. A fair test of maps on the same cases would need a blind agent to draw a map before the task, update it after, and a judge to ask whether the map's diff showed the change that later caused trouble. That hasn't been run.

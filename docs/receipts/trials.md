# What the first two receipts taught us

Both trials ran on 2026-11-03, on changes to another of the author's projects. The receipts themselves aren't included here. This page keeps the lessons.

## Trial 1: the after-step on its own

The rows were agreed between agent sessions before the work, without a person approving them, so this trial only tested the step after the work.

All 8 rows matched, and each one names a run on a fresh, clean clone. There were no tampering flags. No scope was declared before the work, so the receipt recorded the scope as "none" instead of inventing one afterwards. Nothing material was caught, on a well-tested, deterministic change.

These are the lessons.

1. The after-step works and takes under 5 minutes. Done by an agent, it isn't cheap: 132,000 tokens and 31 tool calls, as counted by the harness. A script that runs fixed checks would cost almost nothing per receipt, so tokens should go into writing checks, not running them.
2. An agent's report of its own cost is unreliable. The agent claimed about 120,000 tokens and 24 calls, and said one script took "~10 min" inside a run that took under 5 minutes. Cost and timing should go on a receipt only from the harness or the runner.
3. Checking that something stays the same across two commits works, but each check was a bespoke script. One row needed about 100 lines to build and run the same inputs at the old and new commit and compare the outputs. A small reusable check that runs a command the person names on both commits would cover this.
4. Many claims that the receipt marked as unsupported were true, but the evidence lived somewhere else, such as an independent review or a gate run outside the repo. A receipt needs to attach evidence from other tools and say who judged each item. Without that, every outside check reads as unsupported, and the claim check becomes noise.
5. A task is not the same as a pull request. One pull request bundled three tasks, and the receipt rightly kept their files apart. Rows and scope have to be declared per task, and a pull request can carry several receipts.
6. On well-tested work, the receipt mostly confirms. Its value there is confidence and an audit trail, not catches.

## Trial 2: the first full cycle with approved rows

This was the first time a person approved the rows before the work. There were 6 rows: 4 tests, 1 command checking that something stayed the same, and 1 live check. They were approved unchanged in about 4 minutes. The receipt took about 6 minutes and about 142,000 tokens. Nothing mismatched, and there were no tampering or scope flags. One outside check couldn't run, and the live row was left for the person to check by hand.

These are the lessons.

1. A matched row can rest on a test that passes for the wrong reason. A CodeQL alert, raised after the receipt, showed that a line in a test's setup that was meant to change the input string left it unchanged. The input still failed, but for a different reason than the test meant to check. Planting bugs in the code didn't catch this, because that changes the code under test and not the test's own setup. Three changes follow from this. Each row for a failure case should assert the reason it fails, not just that it fails. Static-analysis alerts on test files should attach to the receipt as evidence. And the receipt should say which matched rows rest on the agent's own tests rather than on checks written independently.
2. A receipt with no mismatches still paid off. It found 3 places where the agent's tests didn't assert what the rows said. The code was right but the evidence was weak, and the agent closed all three gaps in a test-only commit.
3. Test counts depend on build state. The suite's pass count was only true after a build step, because some tests skip themselves when the build is missing. A receipt should record the runtime and build state it ran against.
4. Approval was cheap on a well-specified task, at about 4 minutes with no rows changed. That is one data point. Whether approval catches misunderstandings is still the open question.

# Receipts

A receipt is a record that checks an agent's "done" against examples that a person approved before the work started. Each example, called a row, says "given this situation, expect this outcome", or says what must stay the same. After the agent finishes, something other than that agent runs every row and writes down what happened, with the evidence, any edited or skipped tests, and any files changed outside the agreed scope.

There is no receipt code in Vantle yet. So far the receipt has been run by hand, with an agent skill and a fixed format, to learn whether it catches anything and what it costs. The story and the numbers are in the post [Making Vantle, part 1](https://raymondyang.dev/writing/done-is-doing-a-lot-of-work).

## What's here

| File | What it is |
|---|---|
| [rows-template.md](./rows-template.md) | The row format and the steps for running rows by hand. |
| [skills/vantle-rows/SKILL.md](./skills/vantle-rows/SKILL.md) | An agent skill that proposes rows before the work, waits for approval, and has a fresh subagent write the receipt afterwards. |
| [trials.md](./trials.md) | What the first two receipts on real changes taught us. |
| [historic-replay.md](./historic-replay.md) | The protocol and results of a replay of 6 past bugs and 10 controls. It caught 0 of the 6. |
| [skills/vantle-map/](./skills/vantle-map/) | A separate trial of maps above the code: an agent skill and a small anchor checker. See the roadmap for how it relates to receipts. |

The skills are written for Claude Code, but the format is plain Markdown and should work with any agent that can follow written instructions.

## What the trials have and haven't shown

The receipt's plumbing works. Rows can be turned into checks, run on fresh copies of a repo, and recorded with evidence in a few minutes. On well-tested changes, a receipt mostly confirms that the work is right.

What it has not shown is that rows catch bugs. In the replay, rows that an agent wrote from the original request missed all six bugs, because each bug sat next to what the request described rather than inside it. Whether rows that a person reviews and approves do better is the open question, and it's the next thing to test.

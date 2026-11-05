# Roadmap

This is a direction, not a promise. It changes as the experiments come in. The post [Making Vantle, part 1](https://raymondyang.dev/writing/done-is-doing-a-lot-of-work) explains how the project got here.

## Where things stand

Vantle started as a tool that turns a function's decisions into a flowchart and checks the chart against the real code. Measured on 60 functions from 20 public TypeScript repos, the charts missed their own bar, and fresh reviewers kept finding bugs in them after the work was called done. That pointed at a more basic problem than charts. There was no cheap, trustworthy way to check that a change does what was agreed, whoever or whatever made it.

So chart work is paused, and the current focus is the receipt. A receipt checks an agent's "done" against examples that a person approved before the work, and it is decided by running checks, not by an AI reading the code. It has only been run by hand so far. In a replay of 6 past bugs, rows that an agent wrote without anyone reviewing them caught none of them. The bugs sat next to what the request described, not inside it.

## Next

1. **Test rows that a person reviews.** Use the receipt by hand on new behaviour-changing tasks, with rows approved before the work, and count what they catch and what they cost. This decides whether the receipt is worth building.
2. **Find rows the request doesn't name.** Before rows are written, trace what the changed code feeds into and what it already promised, and propose rows for those. Each row records which details the person said and which the agent assumed.
3. **Build the receipt's runner.** This is a script with no AI in it, which runs each row's check on a fresh copy of the repo and writes an evidence record. The record holds the command, the commit, the exit status and the output, along with flags for edited or skipped tests and for files changed outside the agreed scope. It also includes a reusable check that runs the same command on the old and new commit and compares the outputs.
4. **Attach evidence from other tools,** such as CI runs, end-to-end tests and static-analysis alerts, and label each item with who judged it, whether that was a script, an AI judge or a person.

## Later

- **Charts again,** once the receipt has proven itself. The shelved work includes removing arrows that no run can take, keeping track of what a path has already settled, and treating conditions as trees.
- **Maps above the code.** These are diagrams in layers a person chooses, such as system and behaviour, with each box tied to the code behind it and to the evidence that supports it, and with a diff per layer on every change. The hard part is keeping a map true rather than drawing it, so each box shows whether it is checked, stale, unchecked or not tied to any code. A manual trial of this is in [docs/receipts/skills/vantle-map](./docs/receipts/skills/vantle-map/).
- **Editing behaviour from above.** A person changes a box or a row, an agent changes the code, and the receipt checks that the code now does what the edited box says.

## Not planned

- A general-purpose agent orchestrator. Vantle aims to be the check that such a system calls when an agent says done.
- Support for languages other than TypeScript in the chart tool, for now. Receipts and maps don't depend on the language, because their rows and anchors are just commands, files and symbols.

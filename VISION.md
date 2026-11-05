# Vantle vision

Where this could go after v0. None of this is a commitment; [SPEC.md](./SPEC.md) is the commitment.

> This vision was written before the work on receipts. [ROADMAP.md](./ROADMAP.md) is the current direction.

## The problem

Every product has behavior that's hard to see: who gets notified, who can access what, when a charge retries, which users see a feature. That logic is spread across many files, mixes product decisions with engineering details, and lives mostly in people's heads. The code is the only accurate record of it, and most of the people who need to understand it can't read code.

Slack's notification flowchart is the gold standard: one picture of a critical decision, readable by anyone. It was drawn by hand, once, and went out of date the day someone changed the code.

**Vantle aims to make that chart from the code, check it against the code, and keep it current.**

## Two layers

- **Structure:** what the codebase is made of and how modules connect. Module maps, dependency graphs and complexity heatmaps already cover this layer.
- **Behavior:** how a specific decision gets made. This is the layer Vantle works on.

They stack. You zoom in from a module on a structure map to the decision charts inside it.

## Where it goes

### 1. Readable charts you can trust (v0)
Generated from code, verified path by path, rendered wherever markdown renders.

### 2. Charts that stay current
- Regenerate on every PR.
- **Behavior diffs:** a PR comment like *"This PR adds a path: DnD override → Highlight word → YES"*. Reviewers see what changed in behavior, not just which lines changed.
- Agent review pipelines (coding agent → review agent → a person) can flag PRs that change a decision flow.

### 3. A layer for business context
- Notes attached to chart nodes by stable ID ("this exists because of the 2023 enterprise outage") that survive regeneration.
- An easy UI that shows what's hidden between the boxes, with editing for when the chart got something wrong.

### 4. Editing behavior through the chart
Edits come in two kinds, and the UI has to make people choose:
- **"The chart misread the code."** Fix the label or the tool. The code doesn't change.
- **"The code is wrong."** This is a behavior change. The edited chart becomes a spec, and its paths become acceptance tests. An agent changes the code until they pass. Then Vantle regenerates the chart and checks it matches what you drew.

The verify step from v0 drives this loop, so the first version already contains its core.

### Editing the chart's shape
Separate from editing behavior, users can **split** a box into finer boxes or **merge** boxes together to get the chart to the level of detail they want. These are display edits. They're saved as an overrides layer (like notes, keyed by node ID), checked by the same validator, and kept in version history so you can see who reshaped a chart and why. The code never changes.

### Stable identity across edits
v0 node IDs change when the branch itself is edited. Later, Vantle should match nodes between the old and new graph using structure, condition similarity and position, the way git detects renamed files. Then notes, overrides and behavior diffs survive refactors. This becomes a priority once PR diffs exist, since diffs are only readable if unchanged boxes keep their identity.

### 5. Systems
- Charts link to each other: a box like "User in DnD?" opens its own chart.
- Group charts into a **system** (for example, "Notifications"), view it as one picture, and describe a change to the whole system for an agent to carry out.
- Link into structure maps, so modules and behaviors are one interface at different zoom levels.

### 6. More analysis
- **Spec comparison:** "the spec says X; the code decides Y."
- **Duplicated decisions:** three slightly different "is this user allowed?" checks across the codebase. Structure tools find duplicated code; Vantle would find duplicated decisions.

### Rules the chart must obey
Users write rules in plain terms, such as "a muted channel never notifies unless it's a thread you follow." Vantle checks them against every path of the extracted chart, using the same path logic that `vantle score` uses today. The chart is checked against the code, and the rules are checked against the chart, so a passing rule is checked against the code's own chart, not a hand-written model of it. It's only as strong as the checks behind the chart, which are evidence for the inputs tested, not a proof.

### Behavior over time
Decision charts answer "what happens for these inputs right now?" Many bugs only appear across a sequence of events: you read a message on your laptop, then your phone buzzes anyway. Later, Vantle could link decision charts into statecharts (events move the system between states, and each state's decisions are charts) and hand that to a model checker such as TLA+. Today the hard part of TLA+ is keeping the model in sync with the code. Generating the model from verified charts addresses that.

### Hidden coupling
Path tests find routes through the chart that the code can never take, because two checks that look independent read the same data. Right now these are a side effect of verification. Later they can be a feature: "these two boxes are really one decision", or "this arrow never happens", which are good prompts to simplify the code.

### 7. Behavior maps for agents
Most code will soon be written by agents working in agent interfaces (Claude Code, Codex, Cursor). Agents have the same problem new hires do: they can read code, but they don't know which decisions matter or why. Vantle can be infrastructure for that.
- **Context:** agents ask "what decides whether we notify?" through MCP and get the verified chart and its notes, instead of rediscovering the logic on every task.
- **Guardrail:** after an agent changes code, Vantle reports whether a decision flow changed. Changes that weren't intended get caught before review.
- **Contract:** a chart can be marked as protected. Changing it requires a person's sign-off, even when an agent wrote the code.

Humans read charts in a UI, and agents read the same verified data through MCP. One source of truth serves both.

## Languages

Everything after extraction works on a language-neutral graph format. Adding a language takes two pieces:
1. An **extractor** that turns code into the raw graph. tree-sitter can parse almost any language, and language servers (LSP) handle "go to definition."
2. A **test adapter** that runs path tests in that language (pytest, `go test`, JUnit).

Likely order: TypeScript → Python (calls it can't resolve are shown as "unresolved" nodes, never guessed) → Go → Java/Kotlin → Ruby.

## Distribution

- **CLI:** the core. Works in CI and is scriptable.
- **Claude Code skill:** easiest way to try it. Claude does the LLM steps and the CLI checks its work. No API key or setup.
- **MCP server:** the same idea, but for any agent (Cursor, Codex and others).
- **Hosted app:** the UI, team notes, systems and the PR bot.

## Business sketch

- **Open-core:** the CLI is open source, for adoption and so people can see what happens to their code. The hosted product is paid.
- **Paid entry point:** PR behavior diffs, which is a review tool. Review tools sell; documentation tools mostly don't.
- **Buyer later:** eng leadership, for onboarding, review quality and keeping knowledge when people leave.

## Risks

- **Big tools add "explain this as a flowchart."** Copilot, Cursor, Sourcegraph or DeepWiki-style tools could. The defense is what they're unlikely to build: verification, the context layer and editing behavior through the chart. The diagram alone isn't enough.
- **Real code is messy.** Dependency injection, dynamic dispatch and rules stored as data could all make charts unreadable. The tests on 20 public repos in `docs/experiments/` measure how often this happens.
- **Cost and speed.** If a chart is expensive or slow, nobody runs it on every PR. Measure from day one.

## Decisions v0 makes to keep these options open

1. Language-neutral graph format
2. Stable node IDs, with `module` and `symbol` on every node
3. LLM steps behind a JSON boundary that `vantle validate` checks
4. Human notes stored separately from generated output

# Vantle: notes for coding agents

Vantle is a pre-MVP TypeScript CLI, built in public. Read `README.md` and `ROADMAP.md` first. `SPEC.md` describes what the chart tool does, and `docs/receipts/` describes the receipt, which so far is run by hand.

## Everything here is public

This repository is public, and so is everything you write to it. That includes the code and docs, the decisions record and plans, and also commit messages, branch names, pull request titles and descriptions, and review comments. Before you write any of them, check that none of the following is in it.

- Anything about the maintainer's private projects beyond what the maintainer has already published: no file names, function names, pull request numbers, features, numbers or data from them. Experiment scripts may live here, but data and results from private code stay outside the repo.
- Session ids, chat or session links, local paths such as home folders, account or organization ids, API keys and other secrets.
- Names of people other than the maintainer.
- Comparisons with other products, or claims that Vantle is the first or only tool to do something. Add those only when the maintainer asks.

`scripts/leak-check.sh` checks some of this mechanically, and CI runs it on every push and pull request, along with gitleaks. The check reads files, commit messages and authors, branch names, and pull request text. The maintainer's machine also runs a stricter local check before each push. A clean check doesn't prove that nothing private is in your change, so read your own diff and text with the list above in mind.

## Layout

- `src/cli.ts` is the entry point, and `src/project.ts` finds the project and its marked functions. `src/extract/` builds the raw chart from code with ts-morph, `src/graph/` enumerates paths and compares a chart with a hand-written reference, `src/label/` has Claude relabel it and checks the result, `src/verify/` writes and runs path tests, `src/render/` writes the SVG, Mermaid and markdown charts, and `src/scan.ts` ranks functions.
- **The shared contract is the flow JSON** in `src/schema/flow.ts` and `src/schema/labeled.ts`. Extract, label, verify and render all read it, and saved `.vantle/flows/*.json` files must still parse, so a change there needs every caller and the tests changed together.
- `test/` holds the vitest suites. `test/correctness/corpus/` holds small synthetic cases for the correctness check.
- `fixtures/slack-notify` is the main example. `experiments/` holds measurement scripts, and their write-ups are in `docs/experiments/`.
- `docs/receipts/` holds the receipt's row format and hand-run skills. `docs/decisions.md` and `docs/plans/` hold the decisions record and plans.

## Commands (run from the repository root)

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Test: `npm test` (vitest; up to about two minutes)
- Build: `npm run build`, then run the CLI with `node dist/cli.js -p fixtures/slack-notify <command>`
- Correctness check: `npx tsx experiments/correctness.ts`, which runs each corpus case on many inputs and checks every run against its chart
- Leak check: `scripts/leak-check.sh`
- Workflow check: `python3 .claude/workflow/check.py`

The correctness corpus takes synthetic cases only. Its README says how to write one. Don't copy code from other repositories into tests or fixtures, because this repo is Apache-2.0 and their licences may not allow it. `label` and `verify` call the Anthropic API and need credentials. Unit tests and the correctness check don't.

## Working agreements

- **Never change files on the default branch** (`main`). Branch first (`git checkout -b <slug>`) and open a pull request. `.claude/hooks/guard-default-branch.py` blocks Edit/Write there as a backstop, but cannot see shell writes (`sed -i`, `>>`).
- Don't add AI attribution to commits or pull requests: no `Co-Authored-By` trailer for an AI and no "Generated with" line.
- Keep the status honest. Vantle is pre-MVP, and the docs say so. Don't describe anything as verified, proven or working beyond what a run has shown.
- Write in full, plain sentences. In running prose, avoid a short lead-in followed by a colon and sentence fragments.
- Record decisions a later session could plausibly reopen (direction, architecture, contracts, security and privacy, licensing, rejected alternatives): one line in the auto-loaded index @docs/decisions.md and the full entry in its `docs/decisions/<theme>.md`. The index header sets the format and budget.
- For large milestones, write the plan to `docs/plans/YYYY-MM-DD-<slug>.md` from `docs/plans/_template.md`, so a fresh session can execute it from the file alone. Keep its `Status:` line and the active list in `docs/plans/README.md` current.
- `CLAUDE.md` loads in every session and is capped at 14 KB by the workflow check. Always-on text is for a rule every session needs; add some only by cutting some. Procedures go in a skill, area rules in `.claude/rules/` with a `paths:` header.

## Orchestration and delegation

For non-trivial work the lead session is the orchestrator: it owns the goal, the architecture, the task graph, integration and every exchange with the maintainer. Workers are the agents in `.claude/agents/` (`planner`, `architect`, `executor`, `reviewer`, `Explore`); their checklists and report formats live there.

- **Milestone specs: do not edit files until the architecture and the first small change are explained and approved.** Inspect read-only first.
- Decompose work into tasks with dependencies, complexity class, success criteria, escalation conditions and verification. **Price every task in the maintainer's hours**: they are the scarcest resource.
- Work directly when a task is small, tightly coupled or cheaper to do than to brief. Delegate when work can run concurrently, is self-contained, would flood the lead's context, or needs a fresh judgment. Every worker gets a bounded task and ends with SUCCESS, ESCALATE or BLOCKED; on ESCALATE or BLOCKED, stop the tasks that depend on it and update the plan.
- Present the task graph, delegation, model classes and approval gates **before dispatching code-writing workers**, unless the maintainer has authorised autonomous work. Read-only workers need no approval. Ask before anything that changes product behaviour, architecture, compatibility, security or privacy posture, scope or cost.

### Owner-only actions (each time, never implied by plan approval)

- Merging into the default branch.
- Publishing a release, meaning tags, GitHub releases or npm packages. There are none yet.
- Changing repository settings or visibility, or posting about the project anywhere public.
- API spend beyond a few dollars, such as `label` or `verify` over many functions or a whole corpus.

### Model routing

**The lead runs on Opus at high effort**, chosen at the start of a session. Plans name capability classes; map them at dispatch: ROUTINE → Sonnet (Haiku for lookups), STRONG → Opus, FRONTIER → Fable. Update the mapping when models change.

| Agent | Default | Use |
|---|---|---|
| `Explore` | Haiku, low | code search; fetching one decision entry, plan task or doc section |
| `executor` | Sonnet, medium | ROUTINE tasks; override to Opus for STRONG |
| `reviewer` | Opus, high | every review; Sonnet only for ROUTINE-only work |
| `planner` | Fable, high | milestone plans, re-plans after an ESCALATE |
| `architect` | Fable, high | judgement calls mid-task; resume it with `SendMessage` for follow-ups |

- Call FRONTIER where it pays: a milestone plan, a rule or bar set before measuring, a re-plan, a result the lead cannot explain, a root cause after two strikes.
- **Keep the lead's context small.** The lead does not read a decisions theme file or a plan over ~30 KB itself; `Explore` fetches the entry or task it needs.
- **Don't switch the lead's model or effort mid-session**: each model has its own prompt cache, so the next turn re-reads the whole conversation uncached. Ask `architect`, or start a session.
- Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: it ignores the agent files' `model`.

### Concurrency

- Before running workers at the same time, or beside another lead session, load the `parallel-work` skill.
- Every concurrent code-writing worker gets its own worktree. Stage explicit paths; never `git add .` or a whole directory.
- There are no single-instance resources: tests and the correctness check use temporary folders. A new worktree lacks `node_modules` and `dist/`, so run `npm ci` and `npm run build` there first.

### Review, integration and closeout

- Run `/checkpoint` (the `checkpoint` skill) after each integrated step.
- **Two strikes:** when the same test, typecheck or build error survives two fix attempts, stop patching. Ask `reviewer` (or `architect` when the cause is unclear) for a root-cause read before a third attempt; a worker reports ESCALATE instead.
- Before declaring any change done, run `reviewer` with fresh context on the plan and the diff, for at least two passes on non-trivial work. Passing tests are not proof. Fix the material findings, re-run the checks.
- Ending a session mid-task, switching topic, or past ~300–400k tokens: run `/handoff` (the `handoff` skill). It records state in the repository and prints a short prompt for the next session. Don't let a conversation be the only place work's state lives.
- **Close out:** the plan's `Status:` line and the active list; the execution log compressed into the completion summary with its lesson or `NO_ENTRY`; decision lines that meet the index bar; a short summary for the maintainer.

<!-- Workflow kit (full). `workflow-kit sync` updates the managed files under .claude/; this file
is the repository's own. -->

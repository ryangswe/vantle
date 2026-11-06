# Decisions — Direction & licensing

Full rationale for this theme's decisions, newest first. The lean, auto-loaded index is
`docs/decisions.md`.

---

## 2026-11-05 — Charts are drawn as SVG laid out by ELK (elkjs, EPL-2.0), in the style of the post's Slack chart; Mermaid stays as a folded second copy

**Status:** live, indexed

**Context.** The Slack chart in the post "Making Vantle, part 1" was drawn from Vantle's output by
a one-off script that used ELK. The maintainer preferred its style to Vantle's Mermaid charts and
asked for Vantle itself to draw charts that way.

**Decision.** `src/render/svg.ts` lays out every chart with ELK's layered algorithm. Arrows run at
right angles. "Yes" leaves a box from the bottom and "no" from the right, each switch case leaves
from its own slot sized to its label, and every arrow into an outcome gets its own end. `render`,
`generate` and `verify` write `<flow>.svg`, and the markdown page shows it with the Mermaid chart
folded below. elkjs is pinned to 0.9.3, the version that drew the post's chart, so the two match.
It is EPL-2.0 and used unmodified from npm. No third-party notice was added.

**Rejected.**
- *Mermaid only.* Vantle's Mermaid output couldn't set which side of a box an arrow leaves from,
  or give each arrow into an outcome its own end, and those are what the maintainer liked.
- *`NETWORK_SIMPLEX` node placement.* It drifted into a staircase. `LINEAR_SEGMENTS` was the most
  compact of the placements tried.

---

## 2026-11-05 — Apache-2.0; tests, fixtures and the correctness corpus use synthetic code only

**Status:** live, indexed

**Context.** Vantle was published under Apache-2.0. Some corpus cases first borrowed code from
public functions, and they were rewritten as synthetic ones so the repository can be
published under its own licence.

**Decision.** The project is Apache-2.0. Tests, fixtures and correctness-corpus cases are written
for this project, and may borrow only a function's shape. Code from other repositories is never
copied in.

---

## 2026-11-03 — The receipt comes first; chart work is paused, apart from how charts are drawn

**Status:** live, indexed

Decided when the receipt trials began on 2026-11-03, and recorded here on 2026-11-05.

**Context.** Measured on 60 functions from 20 public TypeScript repos, the charts missed their own
bar, and reviewers kept finding bugs after work was called done. That pointed at a more basic
problem, which was that there was no cheap, trustworthy way to check that a change does what was
agreed.

**Decision.** The current focus is the receipt, which checks an agent's "done" against example
rows a person approved before the work. Chart work is paused until the receipt proves itself.
`ROADMAP.md` holds the order of work. The one exception so far is how charts are drawn.

**Rejected.**
- *Continuing to fix charts first.* More chart fixes would not answer whether a change did what
  was agreed.

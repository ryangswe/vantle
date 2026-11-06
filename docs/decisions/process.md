# Decisions — Process & tooling

Full rationale for this theme's decisions, newest first. The lean, auto-loaded index is
`docs/decisions.md`.

---

## 2026-11-06 — main takes changes only by pull request with `test` and `check` green; Dependabot proposes monthly grouped updates, with elkjs and ts-morph and vitest majors held

**Status:** live, indexed

**Context.** Until now nothing stopped a change with failing checks from reaching `main`, or a
direct push from skipping review. Dependencies were only updated by hand, and GitHub's secret
scanning was off.

**Decision.** A ruleset on `main` blocks deleting and force-pushing it, takes changes only through
pull requests, and requires the `test` and `check` jobs to pass. The maintainer can bypass these
rules only when merging a pull request, where GitHub asks them to confirm it; a direct push to
`main` is refused for everyone. GitHub's secret scanning with push protection, Dependabot alerts
and Dependabot security updates are on. `.github/dependabot.yml` opens one grouped pull request a
month for npm minor and patch updates, one pull request per major update, and one grouped pull
request for GitHub Actions, with no auto-merge. elkjs is held at 0.9.3, for security updates too,
because a new version can change the committed SVGs. Major updates of ts-morph and vitest are held
because they can change the extractor's charts or the generated path tests.

**Rejected.**
- *Auto-merging small updates.* Every change here is public and reviewed, and a monthly pull
  request is cheap to read.
- *Requiring an approving review.* The maintainer is the only reviewer with merge rights, so a
  required approval would only add a bypass click.

---

## 2026-11-05 — Adopted the workflow kit at the full level, with its process files and this record published in the public repo

**Status:** live, indexed

**Context.** Vantle is a multi-session project. Until now its plans and decisions lived in
conversations and in notes outside the repository, so a new session could only rebuild them by
asking. The maintainer asked for the same written workflow used in their other projects, at the
full level.

**Decision.** The repository uses the workflow kit (github.com/ryangswe/claude-workflow) at the
**full** level. That means a committed `.claude/` with the planner, architect, executor, reviewer
and Explore agents, the checkpoint, handoff and parallel-work skills, and a branch guard. It also
means this decisions record, plans in `docs/plans/`, and `.claude/workflow/check.py`, which CI runs,
keeping them consistent. The kit's managed files are updated with `workflow-kit sync`.
`CLAUDE.md` and these docs are the repository's own. Everything here is public, so entries follow
the rules in `CLAUDE.md`.

**Rejected.**
- *The light level.* It has no plans or planner, and Vantle runs over many sessions.
- *Keeping the process files private.* Vantle is built in public, and the files describe how the
  work is done without anything sensitive in them.

---

## 2026-11-05 — Built in public, guarded by CLAUDE.md's public rules, a CI leak check with gitleaks, and a stricter local check kept outside the repo

**Status:** live, indexed

**Context.** The repository went public on 2026-11-05. Everything written to it is published,
including commit messages, branch names and pull request text, and agents write much of it.

**Decision.** `CLAUDE.md` lists what must never be written here. `scripts/leak-check.sh` checks
files, commit messages and authors, branch names and pull request text for home paths, ids, keys
and AI attribution, and CI runs it with gitleaks on every push and pull request. The maintainer's
machine runs a stricter pre-push check whose patterns can't be published, so it lives outside the
repository. The maintainer merges every change, after a fresh-context review of at least two
passes on non-trivial work.

**Rejected.**
- *Relying on the public check alone.* Some patterns would reveal what they protect if published.

**Deferred.** The Claude CI workflows aren't included yet, because they're tied to the author's
Anthropic account, as the README says.

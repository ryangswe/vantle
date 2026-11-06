# Decisions index

One short line per **live** decision, so every session sees the settled surface cheaply and does
not re-litigate it. **This index is auto-loaded every session**, so every byte is paid by every
conversation. The *why*, the rejected alternatives and every past decision live in the per-theme
detail files under `docs/decisions/` named in each heading. **Before reopening or contradicting a
decision, read its detail entry**: `rg -A2 '^## 20'` on the theme file lists every entry with its
status; read that entry only, not the file.

**What earns an entry:** a choice a future session could plausibly reopen: direction,
architecture, contracts, security and privacy posture, licensing, or an alternative that was tried
and rejected. **Not an entry:** experiment results, details settled inside an approved plan, and
anything the code already shows.

**Format and budget** (checked by `.claude/workflow/check.py`):
- `- YYYY-MM-DD — <decision>`, newest first under its theme, at most 250 characters (aim for about
  150).
- Each detail entry opens with `**Status:**` `live, indexed`, `live, not indexed`, `superseded by
  <date>`, `withdrawn` or `record` (results only). Update it when its line goes. An entry covered
  by a line of another date says `live, indexed — under the <date> line`.
- Add the full entry (context, decision, rejected alternatives) to the matching
  `docs/decisions/<theme>.md` as `## YYYY-MM-DD — <decision>`, newest first, `---` between
  entries. Start a new theme file only if none fits, and add its section here.
- The whole index stays under 20 KB. Near it, prune lines first.

---

## Direction & licensing · `docs/decisions/direction.md`

- 2026-11-05 — Charts are drawn as SVG laid out by ELK (elkjs, EPL-2.0), in the style of the post's Slack chart; Mermaid stays as a folded second copy
- 2026-11-05 — Apache-2.0; tests, fixtures and the correctness corpus use synthetic code only
- 2026-11-03 — The receipt comes first; chart work is paused, apart from how charts are drawn

## Process & tooling · `docs/decisions/process.md`

- 2026-11-06 — main takes changes only by pull request with `test` and `check` green; Dependabot proposes monthly grouped updates, with elkjs and ts-morph and vitest majors held
- 2026-11-05 — Adopted the workflow kit at the full level, with its process files and this record published in the public repo
- 2026-11-05 — Built in public, guarded by CLAUDE.md's public rules, a CI leak check with gitleaks, and a stricter local check kept outside the repo

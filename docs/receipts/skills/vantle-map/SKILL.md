---
name: vantle-map
description: Vantle's layer-map trial. Map one area of a repo into 2-3 abstraction layers tied to code, keep the map current after each task or PR, and write a per-layer diff. Use when the user says "vantle-map", "map this area", "update the map", or "layer diff". Read-only on the target repo.
---

# vantle-map (trial: checked maps above the code, by hand)

You keep maps above the code for one area of one repo. They go in layers the user agrees on, tied to code by anchors, updated after each change, with a diff per layer. This is a one-week trial to find out whether a person actually uses such maps. Keep upkeep cheap and honest.

## Hard rules

- **Never edit the target repo.** No file writes, commits, branch switches, stashes or installs there. Use read-only git (`log`, `diff`, `show`, `rev-parse`, `ls-files`) and file reads.
- All map files live in `<maps folder>/<repo-name>/<area>/`, outside the target repo. That folder is its own small git repo, so every map version is kept. Create it with `git init` on first use.
- **Never claim behaviour you didn't check.** A node's `evidence` stays `none` unless a test, command or live check actually ran and you saw the result. Reading the code is not evidence.
- **Relations you propose** carry `"by": "agent", "accepted": false` until the user accepts them.
- **Size limits:** at most ~25 nodes per layer, labels at most 60 characters, plain language. If an area needs more, propose splitting it.

## Commands

### `map <repo path> <area>`: first map

1. Read the area. Propose the layers in 3–5 lines and **wait for the user's OK**. The default set:
   - **System:** components and pipelines;
   - **Behaviour:** what features do in situations, as flows or states;
   - **Anchors:** the code behind the behaviour nodes. These live on the nodes as `anchors`, not as a separate layer, unless the user wants one.
2. Write `map.json` (format below). Record the target repo's HEAD in `repo_commit`, and set each node's `reviewed_at` to it.
3. Render each layer as Mermaid in `layer-<id>.mmd`, then make `MAP.md`, which embeds all the layers and a legend. Draw node status in the label, with text and not just colour:
   - `✓` checked;
   - `~` stale;
   - `?` not checked;
   - `∅` not anchored.
4. Run the checker (below), fix anything it says is missing, and commit the maps folder with the message `map: <area> at <short sha>`.
5. Tell the user: the number of nodes per layer, how many are unanchored, how long it took, and the path to `MAP.md`.

### `update [<base>..<head>]`: after a task or PR

1. Find the range. The default is the last `repo_commit` in `map.json` up to the target repo's current HEAD. Read `git diff --stat` and the diff for files that any node anchors, plus new files in the area.
2. For each affected node, re-read its anchored code and decide whether it's unchanged, changed, removed, or split. Then add new nodes for new behaviour. Set `reviewed_at` on every node you re-reviewed. Update anchors whose code moved.
3. Run the checker, then write `diffs/<yyyy-mm-dd>-<short name>.md`:

   ```markdown
   # Layer diff: <task or PR>, <base short>..<head short>

   ## System
   - added / removed / changed nodes and relations, one line each, each with the code file that justifies it

   ## Behaviour
   - same, and say if an arrow's condition or outcome changed

   ## Health
   - stale: n, missing anchors: n, not anchored: n, checked: n

   ## What the code diff alone wouldn't show
   - one to three lines, or "nothing"

   Upkeep: <minutes>
   ```

4. Commit the maps folder with the message `update: <short name> <base>..<head>`.
5. Append one row to `<maps folder>/trial-log.md`. Fill in the date, repo, task, layer-diff path and upkeep minutes, and leave the user's columns blank.

### `check`

This runs the checker and reports, and changes nothing:

```
python3 -I <skill folder>/check_anchors.py <maps folder>/<repo-name>/<area>/map.json <repo path>
```

## `map.json` format

```json
{
  "repo": "photo-tagger",
  "repo_path": "<absolute path to the repo>",
  "area": "face-detection",
  "repo_commit": "<full sha>",
  "updated": "2026-11-01",
  "layers": [
    {"id": "system", "name": "System", "purpose": "components and how data flows between them"},
    {"id": "behaviour", "name": "Behaviour", "purpose": "what happens in each situation"}
  ],
  "nodes": [
    {
      "id": "behaviour.low-confidence",
      "layer": "behaviour",
      "label": "Low confidence: ask the user to confirm",
      "anchors": [{"path": "tagger/detect.py", "symbol": "detect_faces"}],
      "reviewed_at": "<full sha>",
      "evidence": {"kind": "none"}
    }
  ],
  "edges": [
    {"from": "behaviour.detected", "to": "behaviour.low-confidence", "label": "confidence < 0.6", "layer": "behaviour"}
  ],
  "relations": [
    {"from": "system.detector", "to": "behaviour.low-confidence", "kind": "contains", "by": "agent", "accepted": false}
  ]
}
```

- **Anchor:** `{"path": ..., "symbol": ...}` or `{"path": ..., "lines": [start, end]}`. Paths are relative to the repo root.
- **`evidence`:**
  - `{"kind": "none"}`;
  - or `{"kind": "test" | "command" | "live", "ref": "<test id, command, or what the user checked>", "result": "matched" | "mismatched" | "couldn't run", "at": "<sha>"}`.

## The checker

`check_anchors.py` is deterministic and uses no AI. For every node, it reports one of:
- **missing:** an anchored file or symbol no longer exists;
- **stale:** an anchored file changed after the commit in `reviewed_at`;
- **ok:** neither of the above.

It also counts nodes that are not anchored. A node only shows `✓` if it's ok **and** has evidence with result `matched`.

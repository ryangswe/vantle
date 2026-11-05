"""Check a vantle-map map.json against a repo: missing anchors, stale nodes, unanchored nodes.

Read-only. Usage: python3 -I check_anchors.py <map.json> <repo path> [--json]
"""
import json
import re
import subprocess
import sys
from pathlib import Path


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    return r.returncode, r.stdout


def symbol_present(text, symbol):
    name = re.escape(symbol.split(".")[-1])
    patterns = [
        rf"\b(def|class|function|async\s+function|interface|type|enum)\s+{name}\b",
        rf"\b(const|let|var)\s+{name}\b",
        rf"^\s*{name}\s*[:=(]",
        rf"\b{name}\s*\(.*\)\s*\{{",
    ]
    return any(re.search(p, text, re.MULTILINE) for p in patterns)


def check(map_path, repo):
    m = json.loads(Path(map_path).read_text())
    head_rc, head = git(repo, "rev-parse", "HEAD")
    results = []
    for node in m.get("nodes", []):
        anchors = node.get("anchors") or []
        if not anchors:
            results.append({"id": node["id"], "status": "not anchored", "why": ""})
            continue
        status, why = "ok", []
        for a in anchors:
            f = Path(repo) / a["path"]
            if not f.is_file():
                status = "missing"
                why.append(f"{a['path']} not found")
                continue
            text = f.read_text(errors="replace")
            if "symbol" in a and not symbol_present(text, a["symbol"]):
                status = "missing"
                why.append(f"{a['symbol']} not found in {a['path']}")
            if "lines" in a and len(text.splitlines()) < a["lines"][1]:
                status = "missing"
                why.append(f"{a['path']} is shorter than line {a['lines'][1]}")
            rev = node.get("reviewed_at")
            if status == "ok" and rev:
                rc, out = git(repo, "diff", "--name-only", rev, "HEAD", "--", a["path"])
                if rc != 0:
                    status = "stale"
                    why.append(f"reviewed_at {rev[:7]} not found in repo")
                elif out.strip():
                    status = "stale"
                    why.append(f"{a['path']} changed since {rev[:7]}")
            elif status == "ok" and not rev:
                status = "stale"
                why.append("never reviewed")
        ev = node.get("evidence") or {}
        checked = status == "ok" and ev.get("result") == "matched"
        results.append({"id": node["id"], "status": status, "checked": checked, "why": "; ".join(why)})
    return {"head": head.strip() if head_rc == 0 else None, "nodes": results}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    out = check(sys.argv[1], sys.argv[2])
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
        return
    counts = {}
    for r in out["nodes"]:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    checked = sum(1 for r in out["nodes"] if r.get("checked"))
    print(f"repo HEAD {str(out['head'])[:7]}  nodes {len(out['nodes'])}  checked {checked}  " +
          "  ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    for r in out["nodes"]:
        if r["status"] != "ok":
            print(f"  {r['status']:<13} {r['id']}  {r['why']}")
    sys.exit(1 if counts.get("missing") else 0)


if __name__ == "__main__":
    main()

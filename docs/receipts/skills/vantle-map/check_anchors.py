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


def symbol_present(text, symbol, path=""):
    """Whether `symbol` is defined in `text`.

    A plain name may be defined anywhere in the file. A dotted name such as `Class.method` must be
    a member written directly in the body of `Class` (a class, interface, enum, namespace, object
    literal or Python class), so a local variable inside some method doesn't count. Comments and
    strings are ignored. When the body can't be found, the symbol counts as missing.
    """
    *scopes, name = symbol.split(".")
    if not scopes:
        n = re.escape(name)
        patterns = [
            rf"\b(def|class|function|async\s+function|interface|type|enum)\s+{n}\b",
            rf"\b(const|let|var)\s+{n}\b",
            rf"^\s*{n}\s*[:=(]",
            rf"\b{n}\s*\(.*\)\s*\{{",
        ]
        return any(re.search(p, text, re.MULTILINE) for p in patterns)
    python = path.endswith((".py", ".pyi"))
    code = mask(text, python)
    if not python and len(scopes) == 1 and go_method(code, scopes[0], name):
        return True
    find = python_bodies if python else brace_bodies
    bodies = find(code, scopes[0], nested=False)
    for scope in scopes[1:]:
        bodies = [inner for body in bodies for inner in find(body, scope, nested=True)]
    return any(member_defined(body, name, python) for body in bodies)


def mask(text, python):
    """Blank out comments and string contents, keeping every offset and newline."""
    out = list(text)
    i, n = 0, len(text)

    def blank(a, b, literal):
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "
        # A string or regex still stands for a value, so a line that ends in one isn't left
        # looking unfinished (`url = '...'` must not read as `url =`). The mark goes where the
        # literal starts, which keeps a docstring line's indent.
        if literal:
            out[a] = "0"

    while i < n:
        c = text[i]
        literal = True
        if python and c == "#" or not python and text.startswith("//", i):
            literal = False
            j = text.find("\n", i)
            j = n if j < 0 else j
        elif not python and text.startswith("/*", i):
            literal = False
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif python and text.startswith(('"""', "'''"), i):
            j = text.find(text[i:i + 3], i + 3)
            j = n if j < 0 else j + 3
        elif not python and c in "'\"" and i and (text[i - 1].isalnum() or text[i - 1] == "_") \
                and word_before(text, i) not in WORDS_BEFORE_VALUE:
            i += 1  # an apostrophe in a word, such as JSX text "don't", opens no string
            continue
        elif not python and c == "/" and regex_can_start(text, i):
            j = regex_end(text, i)
            if j is None:
                i += 1
                continue
        elif c in "'\"" or c == "`" and not python:
            j = i + 1
            while j < n and text[j] != c and not (c != "`" and text[j] == "\n"):
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
        else:
            i += 1
            continue
        blank(i, j, literal)
        i = j
    return "".join(out)


REGEX_AFTER = set("(,=:[!&|?{};+-*%~^")
WORDS_BEFORE_VALUE = {"return", "typeof", "case", "in", "of", "yield", "await", "else", "do", "void",
                      "delete", "throw", "extends", "from", "import", "export", "default"}


def word_before(text, i):
    """The identifier that ends just before offset `i`, or ""."""
    k = i
    while k > 0 and (text[k - 1].isalnum() or text[k - 1] in "_$"):
        k -= 1
    return text[k:i]


def regex_can_start(text, i):
    """Whether a `/` at `i` starts a JS regex literal rather than a division."""
    k = i - 1
    while k >= 0 and text[k] in " \t\r\n":
        k -= 1
    if k < 0:
        return True
    if text[k] in REGEX_AFTER or text[k - 1:k + 1] == "=>":
        return True
    return word_before(text, k + 1) in WORDS_BEFORE_VALUE


def regex_end(text, i):
    """The offset after a regex literal that starts at `i`, or None if it doesn't close on its line."""
    j, in_class = i + 1, False
    while j < len(text) and text[j] != "\n":
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == "[":
            in_class = True
        elif text[j] == "]":
            in_class = False
        elif text[j] == "/" and not in_class:
            return j + 1
        j += 1
    return None


def top_level(body):
    """Blank out everything nested inside (), [] or {} in `body`, keeping offsets and newlines."""
    out, depth = list(body), 0
    for k, c in enumerate(body):
        if c in ")]}":
            depth = max(depth - 1, 0)
        if depth and c != "\n":
            out[k] = " "
        if c in "([{":
            depth += 1
    return "".join(out)


def brace_bodies(code, name, nested):
    """The bodies, between their braces, of each class, object or namespace called `name`."""
    n = re.escape(name)
    where = top_level(code) if nested else code
    opens = []
    for m in re.finditer(rf"\b(?:class|interface|enum|namespace|module|struct|trait|object)\s+{n}\b", where):
        opens.append(body_open(code, m.end()))
    for m in re.finditer(rf"\btype\s+{n}\s+(?:struct|interface)\b", where):
        opens.append(body_open(code, m.end()))
    for m in re.finditer(rf"\b(?:const|let|var)\s+{n}\b", where):
        k = assigned_at(code, m.end())
        if k is None:
            continue
        k += len(code[k:]) - len(code[k:].lstrip())
        if code.startswith("{", k):
            opens.append(k)
        elif re.match(r"class\b", code[k:]):
            opens.append(body_open(code, k + 5))
    bodies = []
    for start in opens:
        if start is None:
            continue
        depth = 0
        for k in range(start, len(code)):
            if code[k] == "{":
                depth += 1
            elif code[k] == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(code[start + 1:k])
                    break
    return bodies


def body_open(code, i):
    """The `{` that opens a declaration's body, skipping braces inside <>, () and []."""
    depth = 0
    while i < len(code):
        if code.startswith("=>", i):
            i += 2
            continue
        c = code[i]
        if c == "{" and depth == 0:
            return i
        if c in "([{<":
            depth += 1
        elif c in ")]}>":
            if depth == 0:
                return None
            depth -= 1
        elif c == ";" and depth == 0:
            return None
        i += 1
    return None


def assigned_at(code, i):
    """The offset just after the `=` in `const X: Type = ...`, or None if there isn't one."""
    depth = 0
    while i < len(code):
        if code.startswith("=>", i):
            i += 2
            continue
        c = code[i]
        if c in "([{<":
            depth += 1
        elif c in ")]}>":
            depth -= 1
        elif depth == 0 and c in ";,\n":
            return None
        elif depth == 0 and c == "=" and code[i + 1:i + 2] != "=":
            return i + 1
        i += 1
    return None


def python_bodies(code, name, nested):
    """The indented bodies of each Python class called `name`."""
    bodies = []
    level = member_indent(code) if nested else None
    for m in re.finditer(rf"^([ \t]*)class\s+{re.escape(name)}\b", code, re.MULTILINE):
        if level is not None and m.group(1) != level:
            continue
        depth, k = 0, m.end()
        while k < len(code) and not (code[k] == ":" and depth == 0):
            depth += code[k] in "([{"
            depth -= code[k] in ")]}"
            k += 1
        rest = code[k + 1:]
        line, _, after = rest.partition("\n")
        if line.strip():
            bodies.append(line)
            continue
        lines = []
        for row in after.split("\n"):
            if row.strip() and len(row) - len(row.lstrip()) <= len(m.group(1)):
                break
            lines.append(row)
        bodies.append("\n".join(lines))
    return bodies


def member_indent(body):
    for row in body.split("\n"):
        if row.strip():
            return row[:len(row) - len(row.lstrip())]
    return ""


def member_defined(body, name, python):
    n = re.escape(name)
    if python:
        ind = re.escape(member_indent(body))
        patterns = [
            rf"^{ind}(?:async\s+)?def\s+{n}\b",
            rf"^{ind}class\s+{n}\b",
            rf"^{ind}{n}\s*(?::|=(?!=))",
        ]
        for p in patterns:
            for m in re.finditer(p, body, re.MULTILINE):
                before = body[:m.start()]
                if bracket_depth(before) == 0 and not before.rstrip().endswith("\\"):
                    return True
        return False
    mods = (r"(?:(?:export|default|public|private|protected|static|readonly|abstract|override|declare"
            r"|async|get|set|accessor|function|const|let|var|class|interface|enum|type|namespace)\s+)*")
    decorators = r"(?:@[\w.]+\s*(?:\(\s*\))?\s*)*"
    pattern = rf"(?:^|[;,{{}}])\s*{decorators}{mods}\*?\s*#?{n}\s*[?!]?\s*(?:[(<:=;,}}]|$)"
    tl = top_level(body)
    for m in re.finditer(pattern, tl, re.MULTILINE):
        # A name at the start of a line that continues an initializer, such as `x =` then
        # `  createClient()`, isn't a member.
        if m.group(0)[:1] not in ";,{}" and ends_unfinished(tl, m.start()):
            continue
        return True
    return False


def ends_unfinished(code, i):
    """Whether the code before offset `i` ends in an operator or opener, so the line continues it."""
    k = i - 1
    while k >= 0 and code[k] in " \t\r\n":
        k -= 1
    return k >= 0 and code[max(0, k - 1):k + 1].endswith(CONTINUES)


CONTINUES = ("=>", "=", "+", "-", "*", "/", "%", "?", ":", "&", "|", ".", "<", "(", "[")


def bracket_depth(code):
    return sum(c in "([{" for c in code) - sum(c in ")]}" for c in code)


def go_method(code, receiver, name):
    """A Go method `func (r *Receiver) Name(...)`, defined outside its type."""
    pattern = rf"\bfunc\s*\([^)]*\b{re.escape(receiver)}\b[^)]*\)\s*{re.escape(name)}\s*[(\[]"
    return re.search(pattern, code) is not None


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
            if "symbol" in a and not symbol_present(text, a["symbol"], a["path"]):
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

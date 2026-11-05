#!/usr/bin/env bash
# Fails if the repo, or the text files passed in, contain things that must never be public here:
# local home paths, session or account ids, links to chat sessions, API keys, and AI attribution
# trailers. The maintainer's machine also runs a stricter private check before each push.
#
# Usage: scripts/leak-check.sh            checks every tracked file
#        scripts/leak-check.sh <file>...  checks those files (CI uses this for PR text and commit messages)
# Exit status: 0 clean, 1 something found, 2 the check itself failed.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

# Matched with case: macOS and Linux home folders. (Lower-case /users/ is common in web routes.)
paths='/Users/[A-Za-z]|/home/[a-z]'
# Matched without case. Each pattern is written so that it doesn't match itself.
ids='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|claude\.ai/(code|chat|share)/|\b(session|local|trig|cse)_[0-9A-Za-z]{8,}|\b(fdrl|svac|wrkspc)_[0-9A-Za-z]{8,}|sk-an[t]-'
attribution='co-authored-by:.*(claud[e]|anthropi[c])|generated with \[?claud[e]|noreply@anthropi[c]\.com'

found=0
# Runs one search. grep exits 0 on a match, 1 on none, and 2 or more on an error.
search() {
  "$@"
  local status=$?
  if [ "$status" -eq 0 ]; then found=1
  elif [ "$status" -ne 1 ]; then echo "leak-check: the search itself failed (exit $status)" >&2; exit 2
  fi
}

if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    [ -f "$f" ] || { echo "leak-check: no such file: $f" >&2; exit 2; }
  done
  search grep -nHE "$paths" -- "$@"
  search grep -inHE "$ids|$attribution" -- "$@"
else
  search git -C "$root" grep -nIE "$paths"
  search git -C "$root" grep -inIE "$ids|$attribution"
fi

if [ "$found" -ne 0 ]; then
  echo "leak-check: the lines above must not be published. Remove them, or ask the maintainer." >&2
  exit 1
fi
echo "leak-check: clean"

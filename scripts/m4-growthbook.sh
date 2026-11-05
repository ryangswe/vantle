#!/usr/bin/env bash
# Checks out GrowthBook's JavaScript SDK at a pinned commit and marks runExperiment
# for Vantle. Used by the M4 workflow; safe to run locally too.
set -euo pipefail
DEST="${1:-target/growthbook}"
COMMIT=de93c5d6e17225a800a3d3397cf404096c74991f
rm -rf "$DEST" && mkdir -p "$DEST" && cd "$DEST"
git init -q
git remote add origin https://github.com/growthbook/growthbook.git
git sparse-checkout set packages/sdk-js
git fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
git checkout -q FETCH_HEAD
sed -i 's|^export function runExperiment<T>(|// @vantle: "Is this user in the experiment, and which variation do they get?"\nexport function runExperiment<T>(|' packages/sdk-js/src/core.ts
grep -q '@vantle' packages/sdk-js/src/core.ts
echo "GrowthBook $COMMIT ready in $DEST/packages/sdk-js"

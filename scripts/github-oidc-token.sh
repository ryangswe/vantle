#!/usr/bin/env bash
# Writes a fresh GitHub Actions identity token for Anthropic to $ANTHROPIC_IDENTITY_TOKEN_FILE.
set -euo pipefail
curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.anthropic.com" \
  | jq -r .value > "$ANTHROPIC_IDENTITY_TOKEN_FILE"

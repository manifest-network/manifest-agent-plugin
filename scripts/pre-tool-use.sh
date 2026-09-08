#!/usr/bin/env bash
# Run the host-visible MCP permission policy. Keep a shell fallback so a
# missing Node binary or failed handler emits a deny decision as well.
set -euo pipefail

on_error() {
  trap - ERR
  printf '%s\n' 'manifest-agent permission hook failed; denying this operation' >&2
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Manifest permission hook failed. Repair the plugin before retrying."}}'
  exit 0
}
trap on_error ERR

# Capture the handler output before emitting anything: a failed handler must
# never leave a partial ask/allow response ahead of the fallback deny.
result=$(node "${BASH_SOURCE[0]%/*}/pre-tool-use.cjs")
if [ -n "$result" ]; then
  printf '%s\n' "$result"
fi

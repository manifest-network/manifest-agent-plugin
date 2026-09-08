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

# The child uses a closed token protocol. Never forward arbitrary child stdout:
# even a successful Node shim can print a banner that makes Claude discard JSON.
# Disable inherited preloads; built-in and relative modules need no NODE_PATH.
result=$(NODE_OPTIONS= NODE_PATH= node "${BASH_SOURCE[0]%/*}/pre-tool-use.cjs")
case "$result" in
  ask-direct)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"This Manifest operation can change remote state. Review the requested action and any applicable fee estimate before approving."}}'
    ;;
  ask-orchestrated)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Allow this Manifest operation to start? The server will then request confirmation before changing remote state."}}'
    ;;
  defer) ;; # Explicitly defer to normal host policy for a read-only/non-match.
  *) false ;; # Empty, polluted, or unknown output enters the fail-closed trap.
esac

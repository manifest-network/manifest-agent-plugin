#!/usr/bin/env bash
# PreToolUse hook for manifest-agent broadcast transaction tools.
#
# Wired up in hooks/hooks.json with a matcher that targets every write
# tool across the plugin's MCP servers (cosmos_tx, convert_mfx_to_pwr,
# deploy_app, restart_app, update_app, fund_credit, close_lease).
#
# Emits a PreToolUse decision that forces Claude Code to prompt the user
# for permission before the tool runs. This is a hard safety net: it
# fires regardless of the user's existing permission settings, so a tool
# cannot silently broadcast even if pre-approved.
#
# Fail-closed: any unexpected error (bash crash, missing binary, etc.)
# triggers the ERR trap which emits a `deny` decision instead. A broken
# safety-net script that silently fell through to "allow" (Claude Code's
# default when a PreToolUse hook emits no decision) would be worse than
# useless — it would hide the failure.
#
# The textual fee summary (or action + balance summary) the agent must
# show BEFORE the tool call is a separate obligation enforced by the
# runtime policy injected by scripts/session-start.sh. This hook does
# not and cannot verify that step happened.

set -euo pipefail

on_error() {
  # Disarm the ERR trap before emitting so a failure inside this handler
  # cannot re-trigger the trap. Use `printf` (a bash builtin) rather than
  # `cat` so an empty $PATH or missing coreutils cannot break the
  # fail-closed path on a safety-critical hook.
  trap - ERR
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"manifest-agent pre-tool-use hook errored; refusing to broadcast until the hook is fixed."}}'
  exit 0
}
trap on_error ERR

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "manifest-agent: broadcast transaction. Confirm the agent showed you a fee estimate (cosmos_tx) or an action + balance summary (other tools) before approving."
  }
}
JSON

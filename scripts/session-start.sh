#!/usr/bin/env bash
# SessionStart hook for the manifest-agent plugin.
#
# Two responsibilities:
#   1. Emit the runtime transaction policy on stdout so it is injected
#      into every Claude session that uses the plugin. Plugin CLAUDE.md
#      files are developer docs and do NOT reach runtime sessions — this
#      heredoc is the canonical source of the runtime-facing policy.
#   2. Export MANIFEST_PLUGIN_ROOT via CLAUDE_ENV_FILE so skills can
#      locate plugin scripts from bash commands.
#
# Ordering is deliberate: policy injection runs first so it is locked
# into the session regardless of what happens with the env-file write.
# `set -euo pipefail` + trailing env-file write means a failed write
# produces a non-zero exit Claude Code can surface, rather than silently
# leaving the session in a half-enforced state (policy present but
# MANIFEST_PLUGIN_ROOT missing, causing later skill failures).
#
# Edit the policy text below (not CLAUDE.md) if you need to change
# runtime behavior.

set -euo pipefail

cat <<'POLICY'
# manifest-agent runtime transaction policy

The manifest-agent plugin exposes MCP tools that broadcast Cosmos SDK
transactions on the Manifest blockchain and spend the agent's funds.
The rules below apply to every session where these tools are available.

## Pre-broadcast confirmation (mandatory)

Each broadcast needs its own explicit user confirmation in chat. Never
infer approval from silence, from a prior unrelated approval, or from
the fact that the user asked for the action.

- **For `cosmos_tx` (chain server):** Call `cosmos_estimate_fee` first
  with the same `module`, `subcommand`, `args`, and `gas_multiplier`
  you intend to pass to `cosmos_tx`. Show the returned gas and fee in
  human-readable form (amount + denom symbol, e.g. `0.0023 MFX`), then
  wait for the user to confirm before calling `cosmos_tx`.
- **For transaction tools without a matching estimate call**
  (`convert_mfx_to_pwr`, `deploy_app`, `restart_app`, `update_app`,
  `fund_credit`, `close_lease`): no programmatic fee number exists
  before broadcast. Describe the action concretely (what, where, how
  much), query the agent's balance for the gas denom (via `cosmos_query`
  with `module: "bank", subcommand: "balances"`) and show it so the
  user has an upper bound on potential loss, and note that the exact
  fee will be determined at broadcast time. Then wait for confirmation.

## Gas retry

If `cosmos_tx` fails with an out-of-gas error, retry **once** with
`gas_multiplier` bumped by `0.1` from its current value (starting from
the server-configured `gasMultiplier` in `config.json`, default `1.5`).
Before the retry broadcast, re-run `cosmos_estimate_fee` with the new
multiplier and get a fresh confirmation — the original approval was
for a different fee. Do not retry a second time: if the retry also
fails, report both failures and stop. If `cosmos_estimate_fee` itself
throws while preparing the retry, surface that error alongside the
original OOG and do not broadcast.

## Enforcement note

Claude Code also runs a PreToolUse hook that forces a user permission
prompt before any broadcast tool runs, regardless of pre-existing
permission settings. That prompt is a safety net — it does not replace
the textual fee summary and confirmation you must provide first. If
the user sees a permission prompt for a broadcast tool without having
first seen a fee estimate (for `cosmos_tx`) or an action + balance
summary (for other tools) from you, you have violated this policy.

## Lease lifecycle

To deploy a new containerized app (create a lease and upload its
payload), use `deploy_app`. It couples the on-chain `billing
create-lease` tx, the SHA-256 `--meta-hash` commitment, the
ADR-036-authenticated payload upload, and the readiness poll into a
single atomic flow. To change a running app's manifest without
closing its lease, use `update_app`. Do **not** assemble either flow
from raw `cosmos_tx` calls: getting the meta-hash / payload coupling
wrong produces orphan leases that continue consuming credit until
closed. The `/manifest-agent:deploy-app` and
`/manifest-agent:update-app` skills wrap these tools with the
supporting checks (credit balance, SKU selection, echo+confirm,
current-manifest fetch for partial updates).
POLICY

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export MANIFEST_PLUGIN_ROOT=\"${CLAUDE_PLUGIN_ROOT}\"" >> "$CLAUDE_ENV_FILE"
fi

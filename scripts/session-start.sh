#!/usr/bin/env bash
# SessionStart hook for the manifest-agent plugin.
#
# Three responsibilities:
#   1. Emit the runtime transaction policy on stdout so it is injected
#      into every Claude session that uses the plugin. Plugin CLAUDE.md
#      files are developer docs and do NOT reach runtime sessions — this
#      heredoc is the canonical source of the runtime-facing policy.
#   2. Export MANIFEST_PLUGIN_ROOT and MANIFEST_PLUGIN_DATA via
#      CLAUDE_ENV_FILE so skills can locate plugin scripts and the
#      runtime data directory from bash commands. MANIFEST_PLUGIN_DATA
#      is Claude Code's persistent per-plugin data directory
#      (~/.claude/plugins/data/<id>/) — survives plugin updates.
#   3. Bootstrap npm dependencies on first run / when package.json
#      changes (diff-check pattern from the docs). Removes the failure
#      mode where a fresh user invokes /manifest-agent:deploy-app
#      before /manifest-agent:init-agent and the MCP wrapper crashes
#      with "binary not found".
#
# Ordering is deliberate: policy injection runs first so it is locked
# into the session regardless of what happens with the env-file write
# or npm install. `set -euo pipefail` means a failed write produces a
# non-zero exit Claude Code can surface, rather than silently leaving
# the session in a half-enforced state.
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

- **For chain-broadcast tools that wrap `cosmosTx` under the hood**
  (`deploy_app`, `close_lease`, `fund_credit`, `set_item_custom_domain`):
  these all broadcast Cosmos SDK billing-module transactions, so
  `cosmos_estimate_fee` applies. Call it first, show the returned
  `gasEstimate` and `fee.amount` in human-readable form, then wait for
  confirmation.
    - `deploy_app`: call
      `cosmos_estimate_fee({module: "billing", subcommand: "create-lease", args: ["--meta-hash", <meta_hash_hex>, "<skuUuid>:1[:<svcName>]", ...]})`.
      Use `meta_hash_hex` from `build_manifest_preview` and `sku.uuid`
      from `check_deployment_readiness`. For multi-service stacks,
      append one `<skuUuid>:1:<svcName>` per service. For storage,
      append `<storageSkuUuid>:1` (look up the storage SKU UUID via
      `mcp__manifest-lease__get_skus` if you don't have it cached).
      **When `custom_domain` is set on `deploy_app`**, the call broadcasts
      TWO billing txes atomically (`create-lease` + `set-item-custom-domain`).
      The single PreToolUse permission prompt covers both — the textual
      DeploymentPlan + intent recap MUST itemize both fees and both txes
      so the per-tx acknowledgement is in the textual flow. Estimate the
      second tx by querying `mcp__manifest-lease__leases_by_tenant` for
      the signer's first ACTIVE lease and running
      `cosmos_estimate_fee({module: "billing", subcommand: "set-item-custom-domain", args: ["<existing_owned_lease_uuid>", "<fqdn-to-be-claimed>"[, "--service-name", "<svc>"]]})`.
      The fee is essentially fixed for this msg type; using a
      representative existing lease passes the keeper's ownership check.
      If no representative lease exists, allowed degradation: pass
      `--set-domain-tx-fee skipped` to render-deployment-plan.cjs (which
      owns the canonical "not estimated" marker). The plan renders the
      script's verbatim message; surface the gap explicitly in the recap.
      Do NOT silently omit it.
    - `close_lease`: call
      `cosmos_estimate_fee({module: "billing", subcommand: "close-lease", args: ["<lease_uuid>"]})`.
    - `fund_credit`: call
      `cosmos_estimate_fee({module: "billing", subcommand: "fund-credit", args: ["<amount>"[, "--tenant", "<addr>"]]})`
      where `<amount>` is the same string you'll pass to `fund_credit`
      (e.g. `"10000000umfx"`).
    - `set_item_custom_domain` (standalone, not via deploy_app): call
      `cosmos_estimate_fee({module: "billing", subcommand: "set-item-custom-domain", args: ["<lease_uuid>", "<fqdn>"[, "--service-name", "<svc>"][, "--clear"]]})`.
      For clear-only, omit the `<fqdn>` positional and pass `--clear`.

  If `cosmos_estimate_fee` itself fails, surface the error and ask the
  user whether to proceed without an estimate — do NOT silently skip.
  When you broadcast, pass the same `gas_multiplier` you used for the
  estimate so the actual fee matches what was previewed.

  Exception for `deploy_app` routed through `/manifest-agent:deploy-app`:
  the orchestrator also calls `check_deployment_readiness` once during
  authoring. Its `wallet_balances[]` field IS the bank balances and is
  the canonical source for the DeploymentPlan `Wallet:` line — do not
  re-query for that. The `cosmos_estimate_fee` call above is in
  addition to the readiness check, not a replacement.

- **For chain-broadcast tools with a different transaction shape**
  (`convert_mfx_to_pwr`, which broadcasts a CosmWasm
  `MsgExecuteContract` rather than a Cosmos SDK module/subcommand):
  `cosmos_estimate_fee` does not apply. Describe the action concretely
  (what, where, how much), query the agent's balance for the gas denom
  (via `cosmos_query` with `module: "bank", subcommand: "balances"`),
  show it so the user has an upper bound on potential loss, and note
  that the exact fee will be determined at broadcast time. Then wait
  for confirmation.

- **For provider-side write tools that do NOT broadcast on-chain**
  (`restart_app`, `update_app`): these are HTTPS calls to the
  provider, not Cosmos transactions. No gas, no estimate. The
  PreToolUse permission prompt still fires; describe the action and
  wait for textual confirmation, but do not query balances or call
  `cosmos_estimate_fee`.

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

## Deployment plan format (deploy_app)

Before broadcasting `mcp__manifest-fred__deploy_app`, render a
`DeploymentPlan` block and wait for textual confirmation. The
canonical block is produced by `scripts/render-deployment-plan.cjs`
in this plugin — print that script's stdout verbatim. Do NOT compose
the block by hand; the script owns the field names, ordering, and
spacing so the agent and the runtime policy cannot drift.

The `Provider` field is intentionally absent from the block: the
chain selects a provider internally during `deploy_app`, so it is
not knowable pre-broadcast. Print the resolved provider name in the
success output. On the typical happy path it comes from the
`deploy_app` response itself (`provider_uuid` plus a `browse_catalog`
lookup); on the fallback path where `deploy_app` returns without an
active connection, the orchestrator calls `wait_for_app_ready` and
`app_status` to obtain it instead.

Note that `check_deployment_readiness` does not validate the image
registry allowlist — that check fires inside `deploy_app` at upload
time. Surface the rejection verbatim if it happens, and offer
`close_lease` if a lease was already created.

## Enforcement note

Claude Code also runs a PreToolUse hook that forces a user permission
prompt before any broadcast tool runs, regardless of pre-existing
permission settings. That prompt is a safety net — it does not replace
the textual fee summary and confirmation you must provide first. If
the user sees a permission prompt for a broadcast tool without having
first seen a fee estimate (for `cosmos_tx`) or an action + balance
summary (for other tools) from you, you have violated this policy.
POLICY

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # printf %q quotes the value so paths containing spaces or shell
  # metacharacters round-trip correctly when CLAUDE_ENV_FILE is sourced.
  printf 'export MANIFEST_PLUGIN_ROOT=%q\n' "${CLAUDE_PLUGIN_ROOT}" >> "$CLAUDE_ENV_FILE"
  printf 'export MANIFEST_PLUGIN_DATA=%q\n' "${CLAUDE_PLUGIN_DATA}" >> "$CLAUDE_ENV_FILE"
fi

# Bootstrap deps when package.json differs (or on first run). Pattern from
# the official Claude Code plugins-reference docs. The "|| rm -f" tail
# discards a stale package.json copy on install failure so the next session
# retries instead of pretending it succeeded.
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/package.json" ]; then
  if ! diff -q "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/package.json" >/dev/null 2>&1; then
    cp "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/package.json"
    INSTALL_LOG="${CLAUDE_PLUGIN_DATA}/.last-install.log"
    # Capture stderr+stdout to a log file so failures are diagnosable
    # ("EACCES on cache dir", "ECONNRESET fetching tarball", etc.) instead
    # of just a generic "failed". --silent still suppresses progress noise
    # in the captured log; only errors and warnings show up.
    if (cd "${CLAUDE_PLUGIN_DATA}" && npm install --omit=dev --silent) >"${INSTALL_LOG}" 2>&1; then
      rm -f "${INSTALL_LOG}"
    else
      rm -f "${CLAUDE_PLUGIN_DATA}/package.json"
      printf 'manifest-agent: npm install failed; see %s for details. Will retry next session.\n' "${INSTALL_LOG}" >&2
    fi
  fi
fi

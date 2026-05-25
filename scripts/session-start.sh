#!/usr/bin/env bash
# SessionStart hook for the manifest-agent plugin.
#
# Four responsibilities:
#   1. Emit the runtime transaction policy on stdout so it is injected
#      into every Claude session that uses the plugin. Plugin CLAUDE.md
#      files are developer docs and do NOT reach runtime sessions — this
#      heredoc is the canonical source of the runtime-facing policy.
#   2. Export MANIFEST_PLUGIN_ROOT, MANIFEST_PLUGIN_DATA, and NODE_PATH
#      via CLAUDE_ENV_FILE so skills can locate plugin scripts, the
#      runtime data directory, and resolve plugin-installed Node
#      dependencies from bash commands. MANIFEST_PLUGIN_DATA is Claude
#      Code's persistent per-plugin data directory
#      (~/.claude/plugins/data/<id>/) — survives plugin updates.
#   3. Capture Claude Code's session_id from the SessionStart hook stdin
#      payload and export it as MANIFEST_SESSION_ID (alongside the env
#      file writes in (2)). The operation journal (ENG-124) tags every
#      record with this id so records from one Claude Code session
#      group together.
#   4. Bootstrap npm dependencies on first run / when package.json
#      changes (diff-check pattern from the docs). Removes the failure
#      mode where a fresh user invokes /manifest-agent:deploy-app
#      before /manifest-agent:init-agent and the MCP wrapper crashes
#      with "binary not found".
#
# Ordering is deliberate: stdin is captured first (gated on
# CLAUDE_ENV_FILE since that's the only consumer), then policy
# injection writes to stdout, then env-file writes happen, then npm
# install. `set -euo pipefail` means a failed write produces a non-
# zero exit Claude Code can surface, rather than silently leaving the
# session in a half-enforced state.
#
# Edit the policy text below (not CLAUDE.md) if you need to change
# runtime behavior.

set -euo pipefail

# HOOK_PAYLOAD is only used later inside the `if [ -n
# "${CLAUDE_ENV_FILE:-}" ]` block to extract `session_id` for the
# MANIFEST_SESSION_ID export. Gate the stdin read on the same condition
# so we don't `cat` stdin in invocations that won't consume the payload
# anyway (CI policy-syntax checks, ad-hoc shell test runs) — and so an
# open-but-unflushed pipe in an unusual stdin setup can't hang the
# hook before the policy heredoc emits. `cat || true` is belt-and-
# suspenders against `set -e` propagating a closed-pipe error.
HOOK_PAYLOAD=""
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ ! -t 0 ]; then
  HOOK_PAYLOAD=$(cat || true)
fi

cat <<'POLICY'
# manifest-agent runtime transaction policy

The manifest-agent plugin exposes MCP tools that broadcast Cosmos SDK
transactions on the Manifest blockchain and spend the agent's funds.
The rules below apply to every session where these tools are available.

## Orchestrated agent-server tools (the preferred surface)

The four tools under `mcp__manifest-agent__*_orchestrated`
(`deploy_app_orchestrated`, `manage_domain_orchestrated`,
`troubleshoot_deployment_orchestrated`, `close_lease_orchestrated`)
wrap `manifest-agent-core` flows. They own plan, confirmation,
progress, recovery, and post-broadcast verification end-to-end via
the MCP elicitation + progress-notification protocols.

When you invoke one of these tools:

- The wrapper raises one or more `elicitInput` requests at confirmation
  gates — deployment plan, set-domain confirm, close-lease confirm,
  partial-success recovery choice, mainnet warning. The host renders
  each as a native UI prompt. The user's elicitation response IS the
  binding confirmation.
- **Print each elicitation prompt's `message` body verbatim. Do NOT
  paraphrase, summarize, or splice in extra fields.** `agent-core`'s
  internal `internals/render-*` modules pin the exact wording so
  adjacent runs cannot drift.
- **Do NOT compose your own `DeploymentPlan`, intent recap, or
  fee-itemization block.** The wrapper owns those rendered texts.
- **Do NOT call `cosmos_estimate_fee` yourself before invoking the
  orchestrated tool.** The wrapper runs the estimate internally and
  embeds the result in the elicitation prompt.
- Progress notifications stream during the call; if the host renders
  `notifications/progress`, surface them as inline status updates.
- On thrown errors the wrapper returns a standard MCP error envelope.
  Surface the message verbatim and follow any recovery branch the
  wrapper points at.
- The **inner** broadcast tools the wrapper dispatches
  (`mcp__manifest-fred__deploy_app`,
  `mcp__manifest-lease__set_item_custom_domain`,
  `mcp__manifest-lease__close_lease`, etc.) still trigger the
  PreToolUse permission prompt on their own — that's expected. One
  prompt fires per inner tx.

For `deploy_app_orchestrated` specifically, the wrapper also handles
the dual-tx case (`create-lease` + `set-item-custom-domain` when
`customDomain` is set) — both fees are itemized in the plan
elicitation, both inner txes fire under one MCP tool call, and the
PreToolUse hook prompts once per inner tx.

## Pre-broadcast confirmation for non-orchestrated billing txes

When you call a billing-module broadcast tool **outside** the
orchestrated wrappers — typically `cosmos_tx`, `convert_mfx_to_pwr`,
or a direct `fund_credit` from a setup skill — the old confirmation
discipline applies. After the rewire most flows go through the
orchestrated wrappers, but these patterns remain authoritative for
any non-orchestrated billing tx you find yourself about to broadcast.

- **For `cosmos_tx` (chain server):** Call `cosmos_estimate_fee` first
  with the same `module`, `subcommand`, `args`, and `gas_multiplier`
  you intend to pass to `cosmos_tx`. Show the returned gas and fee in
  human-readable form (amount + denom symbol, e.g. `0.0023 MFX`), then
  wait for the user to confirm before calling `cosmos_tx`.

- **For `fund_credit` (when invoked outside an orchestrated wrapper):**
  Call
  `cosmos_estimate_fee({module: "billing", subcommand: "fund-credit", args: ["<amount>"[, "--tenant", "<addr>"]]})`
  where `<amount>` is the same string you'll pass to `fund_credit`
  (e.g. `"10000000umfx"`). Show the returned `gasEstimate` and
  `fee.amount` in human-readable form, then wait for confirmation.

- **For `convert_mfx_to_pwr`** (CosmWasm `MsgExecuteContract`, not a
  Cosmos SDK module/subcommand): `cosmos_estimate_fee` does not apply.
  Describe the action concretely (what, where, how much), query the
  agent's balance for the gas denom (via `cosmos_query` with
  `module: "bank", subcommand: "balances"`), show it so the user has
  an upper bound on potential loss, note that the exact fee will be
  determined at broadcast time, then wait for confirmation.

- **For provider-side write tools that do NOT broadcast on-chain**
  (`restart_app`, `update_app`): these are HTTPS calls to the
  provider, not Cosmos transactions. No gas, no estimate. The
  PreToolUse permission prompt still fires; describe the action and
  wait for textual confirmation, but do not query balances or call
  `cosmos_estimate_fee`.

If `cosmos_estimate_fee` itself fails, surface the error and ask the
user whether to proceed without an estimate — do NOT silently skip.
When you broadcast, pass the same `gas_multiplier` you used for the
estimate so the actual fee matches what was previewed.

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

The orchestrated agent tools handle gas retry internally for the
wrapped flows; this section applies only to direct `cosmos_tx`
invocations.

## Enforcement note

Claude Code also runs a PreToolUse hook that forces a user permission
prompt before any broadcast tool runs, regardless of pre-existing
permission settings. That prompt is a safety net — it does not replace
the textual fee summary and confirmation you must provide first (for
non-orchestrated broadcasts) or the elicitation flow the orchestrated
wrappers drive (for the four orchestrated tools). The prompt fires on
the **inner** broadcast tools, even when invoked through an
orchestrated wrapper, so the user sees one prompt per inner tx. The
orchestrated wrappers themselves do NOT trigger the hook — the
matcher is anchored on the inner tool names.

If the user sees a permission prompt for a broadcast tool without
having first seen either an elicitation prompt (orchestrated tools)
or a fee/balance summary (direct tx) from you, you have violated
this policy.
POLICY

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # printf %q quotes the value so paths containing spaces or shell
  # metacharacters round-trip correctly when CLAUDE_ENV_FILE is sourced.
  printf 'export MANIFEST_PLUGIN_ROOT=%q\n' "${CLAUDE_PLUGIN_ROOT}" >> "$CLAUDE_ENV_FILE"
  printf 'export MANIFEST_PLUGIN_DATA=%q\n' "${CLAUDE_PLUGIN_DATA}" >> "$CLAUDE_ENV_FILE"
  # NODE_PATH is purely additive (Node consults it as a fallback after the
  # node_modules walk-up), so exporting it session-wide is safe — the only
  # `node` invocations in this plugin's bash scope are the plugin's own
  # scripts, which need exactly this resolution path. Hoisting kills the
  # 9-site duplication that was previously prefixed onto each invocation.
  printf 'export NODE_PATH=%q\n' "${CLAUDE_PLUGIN_DATA}/node_modules" >> "$CLAUDE_ENV_FILE"

  # Extract session_id from the captured hook payload. Use jq when
  # available, otherwise fall back to a tolerant grep+sed. Empty
  # SESSION_ID just skips the export — _journal.cjs treats a missing
  # MANIFEST_SESSION_ID as a null session id in the journal record.
  SESSION_ID=""
  if [ -n "$HOOK_PAYLOAD" ]; then
    if command -v jq >/dev/null 2>&1; then
      SESSION_ID=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)
    else
      # `|| true` is required because `set -o pipefail` is active above:
      # if the payload doesn't contain `session_id`, grep exits 1, the
      # pipeline exits 1, and `set -e` would abort the hook. By the time
      # we reach this block, the policy heredoc has already been emitted
      # to stdout, so the failure mode is aborting the env-file writes
      # (MANIFEST_PLUGIN_ROOT/DATA/NODE_PATH/SESSION_ID) and the npm
      # bootstrap that follow — leaving the session with the runtime
      # policy injected but no env vars exported, which is a degraded
      # state. Failing soft (empty SESSION_ID) is the right posture:
      # the journal records will simply carry `session_id: null` for
      # that session and the rest of the hook completes normally.
      SESSION_ID=$({ printf '%s' "$HOOK_PAYLOAD" \
        | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | head -n1 \
        | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; } || true)
    fi
  fi
  if [ -n "$SESSION_ID" ]; then
    printf 'export MANIFEST_SESSION_ID=%q\n' "$SESSION_ID" >> "$CLAUDE_ENV_FILE"
  fi
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

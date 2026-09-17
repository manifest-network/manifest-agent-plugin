#!/usr/bin/env bash
# SessionStart hook for the manifest-agent plugin.
#
# Five responsibilities:
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
#   4. Use setup-runtime.cjs to install or repair the locked runtime
#      dependencies in persistent data. The same command serves setup
#      skills and recovery; a completion record detects interrupted or
#      incomplete installs even when package.json has not changed.
#   5. On startup, migrate legacy wallet credentials, then deliver the
#      public identity and bounded read-only gas balance check to Claude
#      and the user through structured hook output.
#
# Ordering is deliberate: capture stdin and the canonical policy, export
# the environment, repair dependencies, then migrate and report on startup.
# Completed reports emit a single JSON object. A reporter failure falls back
# to the plain policy with exit 0 so Claude still loads it. Environment and
# setup failures retain their nonzero status and plain diagnostic policy.
# `set -euo pipefail` means a failed write produces a non-
# zero exit Claude Code can surface, rather than silently leaving the
# session in a half-enforced state.
#
# Edit the policy text below (not CLAUDE.md) if you need to change
# runtime behavior.

set -euo pipefail

# With fd 0 closed, Bash can reuse it for command substitution's pipe,
# making `cat` read its own output forever. Normalize it before any capture.
if ! ( exec 3<&0 ) 2>/dev/null; then exec </dev/null; fi

# Only real hook invocations need stdin (session_id and startup source).
# Policy-only CI/ad-hoc invocations must not wait on an unflushed pipe.
HOOK_PAYLOAD=""
if { [ -n "${CLAUDE_ENV_FILE:-}" ] || [ -f "${CLAUDE_PLUGIN_ROOT:-}/package.json" ]; } && [ ! -t 0 ]; then
  HOOK_PAYLOAD=$(cat || true)
fi

RUNTIME_POLICY=$(cat <<'POLICY'
# manifest-agent runtime transaction policy

The manifest-agent plugin exposes MCP tools that broadcast Cosmos SDK
transactions on the Manifest blockchain and spend the agent's funds.
The rules below apply to every session where these tools are available.

## Orchestrated agent-server tools (the preferred surface)

The five tools under `mcp__plugin_manifest-agent_manifest-agent__*_orchestrated`
(`deploy_app_orchestrated`, `manage_domain_orchestrated`,
`troubleshoot_deployment_orchestrated`, `close_lease_orchestrated`,
`lookup_custom_domain_orchestrated`)
wrap `manifest-agent-core` flows. They own plan, confirmation,
progress, recovery, and post-broadcast verification via MCP elicitation.

When you invoke one of these tools:

- For a mutating operation, the PreToolUse hook requests host permission
  BEFORE the outer tool starts. This authorizes starting the operation;
  its native action confirmation happens afterward, inside the tool call.
- The server requests confirmation through native MCP elicitation for
  deployment plans, domain changes, lease closure, mainnet warnings,
  and recovery choices. The host renders these prompts and returns the
  user's answer directly. Do not reconstruct or repeat the prompts or
  treat a model-written answer as the user's confirmation.
- Do not compose a separate DeploymentPlan or fee-itemization block,
  or call `cosmos_estimate_fee` before an orchestrated operation. The
  wrapper owns its confirmation content. The pinned deploy plan includes
  estimated fees; domain and close recaps do not guarantee numeric fees.
- `troubleshoot_deployment_orchestrated` and
  `lookup_custom_domain_orchestrated` are read-only.
  They need no plugin-forced permission or mutation confirmation.
  Handle their returned reports directly.
- If elicitation is unavailable, declined, or cancelled, stop and
  surface the server's result. Do not fall back to a direct write to
  bypass confirmation. During recovery, earlier steps may already have
  succeeded; report that partial state.
- Surface progress notifications and returned errors through the host's
  supported presentation. Follow the recovery options the server offers.
- Internal SDK calls (including `deploy_app`, `set_item_custom_domain`,
  and `close_lease`) do not re-enter the host's MCP dispatcher and do
  not trigger additional PreToolUse hooks. The outer tool is the host
  permission boundary.

A deployment can execute sequential chain transactions, upload a
manifest to a provider, and wait for readiness. It is not atomic:
lease creation can succeed before a later domain or provider step
fails. The wrapper's in-call confirmations and recovery reports cover
these stages; there is no host permission prompt per internal step.

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
  PreToolUse hook still requests host permission; describe the action and
  wait for textual confirmation, but do not query balances or call
  `cosmos_estimate_fee`.

- **For `restore_app`**: this creates a NEW paid lease and adopts retained
  volumes. Read `app_status` / `app_diagnostics` for the source lease's
  retention eligibility first. It is not a restart and is not idempotent.
  The pinned tool has no fee-estimation interface: show the source lease,
  selected chain, available gas/credit balances, and the new lease's billing
  implications, state that the exact fee is unavailable, then get explicit
  confirmation before invoking it. PreToolUse also requests host permission.
  Preserve both source and returned lease UUIDs. If it errors, times out, or
  is cancelled, query existing leases before any retry; never blindly create
  another paid lease. Do not claim its custom domain was restored unless
  verified separately.

- **For matcher-gated lease / fred tools that an orchestrated wrapper
  already covers (`mcp__plugin_manifest-agent_manifest-lease__close_lease`,
  `mcp__plugin_manifest-agent_manifest-lease__set_item_custom_domain`,
  `mcp__plugin_manifest-agent_manifest-fred__deploy_app`,
  `mcp__plugin_manifest-agent_manifest-fred__update_app`):** these are gated by PreToolUse
  but should NOT be invoked directly under normal flows. Route through
  `close_lease_orchestrated` for lease closure,
  `manage_domain_orchestrated` for domain changes, and
  `deploy_app_orchestrated` for both Fred tools (it drives `deploy_app`
  normally and `update_app` during partial-success recovery). The wrappers
  handle action confirmation and verify-and-recover
  via MCP elicitation; direct invocation skips all of that and
  surfaces only the raw PreToolUse permission prompt with no
  preceding fee or action summary, which violates the runtime policy
  above. For exceptional direct close/domain/update calls (e.g.
  recovering from a corrupted state where the wrapper refuses to
  proceed), follow the `cosmos_tx` pattern above for the Cosmos-
  broadcast ones (`close_lease`, `set_item_custom_domain`) — call
  `cosmos_estimate_fee` with `{module: "billing", subcommand:
  "close-lease" | "set-item-custom-domain", args: [...]}`, show the
  humanized fee, and wait for confirmation — or the provider-side
  action-plus-textual-confirm pattern for `update_app`, AND cite the
  explicit reason in your intent recap so the user understands why
  the wrapper is being bypassed. For `deploy_app`, use the orchestrated
  tool's deployment plan and confirmation flow; if it cannot proceed,
  report the blocker instead of falling back to a direct deployment.

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

Claude Code dispatches this hook for the installed plugin's scoped MCP
names. The hook asks before direct writes and mutating outer wrappers,
including provider HTTP writes. A direct write still requires the
preceding action and applicable fee summary described above. For an
orchestrated write, host permission comes first, then the server's
native action elicitation. Seeing the outer permission prompt before
that elicitation is expected.

The hook does not auto-approve any operation. Read-only tools and the
testnet faucet keep the host's normal permission behavior; a domain
lookup emits no plugin decision. Permission handling depends on the
host version and configuration. Do not disable hooks or use unattended
permission bypasses as a substitute for the user's confirmation.

POLICY
)

# Preserve the canonical policy if no structured result can be emitted.
POLICY_EMITTED=false
REPORT_DIR=""
trap 'if [ -n "$REPORT_DIR" ]; then rm -rf -- "$REPORT_DIR" || true; fi; if [ "$POLICY_EMITTED" = false ]; then printf "%s\n" "$RUNTIME_POLICY"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Both hosts resolve root/data/NODE_PATH through the same dependency-free
  # adapter. Claude supplies its persistent path; existing data stays in place.
  if ! command -v node >/dev/null 2>&1; then
    printf 'manifest-agent: Node 22.19.0+ is required. Install Node and restart Claude Code.\n' >&2
    exit 1
  fi
  # The helper appends only the pure adapter's exports using filesystem I/O.
  # Wrapper/preload banners, including exit-time output, stay on stderr.
  node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.cjs" env >&2

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
      # we reach this block, the policy has already been captured, so
      # the failure mode is aborting the env-file writes
      # (MANIFEST_PLUGIN_ROOT/DATA/NODE_PATH/SESSION_ID) and the npm
      # bootstrap that follow — leaving the session with the runtime
      # policy emitted but no env vars exported, which is a degraded
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

# Bootstrap and recovery share one dependency-free entry point. A missing
# Node executable or unsupported version produces a clear hook failure;
# setup failures propagate instead of reporting a successful session setup.
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/package.json" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'manifest-agent: Node 22.19.0+ is required. Install Node and restart Claude Code.\n' >&2
    exit 1
  fi
  MANIFEST_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-runtime.cjs" >&2

  # A full MCP startup includes credential lookup and wallet decryption. Do it
  # only on initial startup, while policy and exports still run on every source.
  # Missing/malformed source preserves direct invocation and older-host behavior.
  SOURCE_STATUS=0
  printf '%s' "$HOOK_PAYLOAD" | node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.cjs" source >&2 || SOURCE_STATUS=$?
  REPORT_MODE=skip
  # Only the explicit skip status suppresses startup; a failed source helper
  # preserves direct invocation/older-host startup behavior.
  if [ "$SOURCE_STATUS" -ne 10 ]; then
    # Persist credentials before the query launcher reads them. Raw helper
    # output never enters the hook JSON: failure uses a fixed recovery message.
    REPORT_MODE=startup
    MIGRATION_STATUS=0
    MANIFEST_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-credentials.cjs" --automatic >&2 || MIGRATION_STATUS=$?
    case "$MIGRATION_STATUS" in
      0) ;;
      2) REPORT_MODE=migration-invalid ;;
      *) REPORT_MODE=migration-failed ;;
    esac
  fi

  # The formatter is buffered and validated before an atomic file write. No
  # arbitrary helper stdout or nonstandard descriptor reaches hook output.
  # Keep all temporary files in our own private directory so EXIT also cleans
  # up a reporter killed during its write. Report failures remain optional.
  REPORT_STATUS=1
  if mkdir -p "${CLAUDE_PLUGIN_DATA}" && REPORT_DIR=$(mktemp -d "${CLAUDE_PLUGIN_DATA}/.session-report.XXXXXX"); then
    REPORT_STATUS=0
    printf '%s\n' "$RUNTIME_POLICY" | MANIFEST_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" \
      MANIFEST_SESSION_REPORT_PATH="$REPORT_DIR/report.json" \
      node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.cjs" report "$REPORT_MODE" >&2 || REPORT_STATUS=$?
    if [ "$REPORT_STATUS" -eq 0 ] && [ -s "$REPORT_DIR/report.json" ] && REPORT_OUTPUT=$(cat "$REPORT_DIR/report.json"); then
      printf '%s\n' "$REPORT_OUTPUT"
      POLICY_EMITTED=true
    fi
  fi
  if [ "$POLICY_EMITTED" = false ]; then
    printf 'manifest-agent: Session report unavailable (reporter status %s); emitting the runtime policy as plain text.\n' "$REPORT_STATUS" >&2
  fi
fi

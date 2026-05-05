# Inline troubleshoot + cleanup (after a deploy-app broadcast that created a lease)

This file is loaded by `skills/deploy-app/SKILL.md` Step 11 when the
`deploy_app` broadcast returned a `LEASE_UUID` but the app didn't come up
healthy (e.g. wait_for_app_ready timed out, deploy_response classified as
`needs_wait` but never transitioned, or `failed` outcome with a lease).

It is a streamlined post-broadcast diagnostic flow — no lease-UUID picker
(we already have it), no tail-size question (default 100), no saved-manifest
summary (deploy-app just persisted it). For full diagnostics on an
arbitrary lease, see `/manifest-agent:troubleshoot-deployment`.

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `LEASE_UUID` — the lease created by deploy-app
- `IMAGE` — the primary image reference (used in the close-lease prompt
  so the user knows what they're closing)
- `<activeChain>` — the active chain name (`testnet` / `mainnet`),
  captured at Step 0 from `update-config.cjs --status`; used to locate
  the chain-data file for `humanize-fee.cjs`

## Diagnostics report

Run these MCP calls in parallel (single message, three tool calls):

- `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__app_diagnostics({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__get_logs({ lease_uuid: LEASE_UUID, tail: 100 })`

Render a brief Markdown report with three sections (Status / Diagnostics /
Recent logs). For the Status section, pipe `app_status` through
`summarize-app-status.cjs` and print its stdout verbatim:

```bash
echo '<app_status JSON>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-app-status.cjs"
```

For Diagnostics: surface `provision_status`, `fail_count`, and `last_error`
from the `app_diagnostics` response, with a plain-English interpretation
of `provision_status`.

For Recent logs: print the log tail in a fenced code block. If logs are
empty, say so.

## Cleanup offer

Before offering cleanup, estimate the close-lease tx fee per the runtime
policy:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "close-lease",
  args: ["<LEASE_UUID>"]
})
```

If the estimate fails, surface the error and ask the user whether to
proceed without one — do not silently skip.

Compute the human-readable fee string with `humanize-fee.cjs` (do NOT
inline the math):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/humanize-fee.cjs" \
  --chain-data-file "$HOME/.manifest-agent/chains/<activeChain>.json" \
  --fee-json '<ESTIMATE.fee.amount as JSON>'
```

Capture the script's stdout as `FEE_HUMAN`. Then offer cleanup via
`AskUserQuestion`. Include the image AND the estimated fee in the prompt
so the user knows what they're paying:

> Close the lease for image `<IMAGE>` (uuid `<LEASE_UUID>`)?
> Estimated tx fee: `<FEE_HUMAN>` (gas `<gasEstimate>`).
> Closing frees the credits this lease was reserving. (yes / no)

If yes, call `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`
(PreToolUse hook will prompt).

## Verify on-chain post-broadcast

A successful broadcast does not guarantee the lease actually transitioned
to a terminal state. The tx might have been accepted into the mempool but
reverted on execution, or the lease state might lag a block. Confirm
explicitly:

1. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
2. Decode `chainState.state` via the JSON mode (which exposes a `terminal`
   flag derived from the canonical state — both `LEASE_STATE_CLOSED` and
   `LEASE_STATE_INSUFFICIENT_FUNDS` count as terminal because the chain may
   transition through INSUFFICIENT_FUNDS on a successful close-lease before
   settling on CLOSED):
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int> --json
   ```
3. Branch on `terminal`:
   - **`terminal: true`** → cleanup. Run:
     ```bash
     node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
     ```
     (no-op if the saved manifest record does not exist). Tell the user
     "Lease is terminal on-chain (`<decoded-name>`). Removed local saved
     manifest record."
   - **`terminal: false`** (typically still `LEASE_STATE_ACTIVE` or
     `LEASE_STATE_PENDING`) → tell the user: "close_lease tx accepted but
     lease state is still `<decoded-name>`; chain may need a moment to
     settle. Re-run `/manifest-agent:troubleshoot-deployment <LEASE_UUID>`
     in ~30s to recheck. Local saved manifest record NOT removed yet."
   - If `app_status` itself errors out: surface the error and tell the
     user the tx was sent but verification failed. Do NOT remove the local
     manifest record.

If the user wants a deeper investigation, suggest
`/manifest-agent:troubleshoot-deployment`.

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

Render the report by piping all three responses to the canonical renderer.
deploy-app just persisted the saved manifest record in Step 10 (or didn't,
on partial-success — either way we don't surface it here), so omit the
`saved_manifest` field:

```bash
echo '{"app_status":<app_status JSON>, "app_diagnostics":<app_diagnostics JSON>, "get_logs":<get_logs JSON>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-troubleshoot-report.cjs"
```

Print the script's stdout verbatim. Do not paraphrase the section bodies;
the renderer owns the field labels and ordering so this flow and the
standalone troubleshoot-deployment skill emit identical structure.

## Cleanup offer

Set up the inputs for the shared billing-tx confirm reference:

- `<estimate-subcommand>` = `"close-lease"`
- `<estimate-args>` = `["<LEASE_UUID>"]`
- `<broadcast-call>` =
  `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`
- `<prompt-body>`:
  > Close the lease for image `<IMAGE>` (uuid `<LEASE_UUID>`)?
  > Closing frees the credits this lease was reserving.

Then `Read` `references/billing-tx-confirm.md` (plugin-root shared
reference; same file is loaded by troubleshoot-deployment Step 6 and
manage-domain Step 6) and follow Steps 1–4 (estimate, fee humanization,
textual confirm, broadcast). The PreToolUse hook will prompt — that's
expected.

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

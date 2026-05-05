---
name: troubleshoot-deployment
description: >
  Diagnose a deployed Manifest lease. Optional argument: a lease UUID (omit
  to pick from active leases or saved post-deploy records). Bundles app
  status, provider diagnostics, and recent container logs into a single
  Markdown report; suggests next steps based on the diagnostic signals; and
  optionally offers close_lease to reclaim a lease that's beyond recovery.
allowed-tools: Bash(*), Read
---

# Troubleshoot Deployment

You are producing a unified troubleshooting report for a deployed app on
Manifest. Bundle live chain state + provider diagnostics + recent logs into a
single Markdown report and suggest next steps.

**For all user choices in this skill, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 4", "Step 6") are scaffolding for skill authors
only. To the user, just describe what you're doing in plain language —
e.g. "Let me gather the lease status, diagnostics, and recent logs", not
"Now in Step 3 I'll run the parallel data gather". Skip phrases like
"Now in Step N" or "Branching to..."; describe the action itself.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; you need `activeChain` for Step 6's fee
humanization.

**Never** read `~/.manifest-agent/config.json` directly.

## Step 1 — Determine the lease UUID

Branches in priority order:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty string that looks
   like a UUID, use it directly. Skip ahead to Step 2.
2. **From `manifest://leases/active` MCP resource**: read the resource. If
   it returns one or more leases, present them via `AskUserQuestion` (show
   lease UUID, image, size, created-at, and `items[].customDomain` when
   non-empty). Let the user pick one. **Add a "Lookup by custom domain"
   option** to the same `AskUserQuestion` so the user can pivot to FQDN
   lookup if they don't recognize the leases shown.
3. **Fallback to saved manifests**: if the resource is empty or unavailable,
   list saved post-deploy records:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```

   The script prints a JSON array of `{ lease_uuid, image, size, deployed_at_iso, chain_id, format?, meta_hash_hex?, schema_version?, custom_domain?, custom_domain_service_name? }` —
   never `manifest_json`. Surface the `custom_domain` in the picker labels
   when present so the user can disambiguate. Include a "Lookup by custom
   domain" option in the picker (same as branch 2).
4. **Lookup by custom domain**: when the user picks this option from
   either branch 2 or 3 (or as a top-level option when no leases exist),
   ask for the FQDN, then call:
   ```
   mcp__manifest-lease__lease_by_custom_domain({ custom_domain: "<fqdn>" })
   ```
   Use the returned `lease.uuid` as `LEASE_UUID`. If the lookup returns no
   lease (FQDN not claimed), surface that and fall back to options 3/5.
5. **Last resort**: tell the user no leases found; ask them to paste a UUID.
   If they don't have one, stop.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Choose log tail length

Use `AskUserQuestion`:

- **50** — quick scan
- **100** (default) — typical debugging
- **500** — deep dive

Store as `TAIL`.

## Step 3 — Gather data (parallel)

Make these three MCP calls in parallel (single message, three tool calls):

- `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__app_diagnostics({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__get_logs({ lease_uuid: LEASE_UUID, tail: TAIL })`

If any call fails, capture the error and continue with the others — partial
information is better than nothing.

## Step 4 — Render the report

Produce a unified Markdown report with these sections:

### Status

Pipe the `app_status` response through `summarize-app-status.cjs` and
print its stdout verbatim under this heading. The script handles the
typed-shape extraction (lease UUID, provider UUID, state decode +
terminal flag, URL extraction from `connection`, `providerError` /
`connectionError` surfacing, and any populated `fredStatus` fields):

```bash
echo '<app_status response JSON>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-app-status.cjs"
```

Do not paraphrase its output; the structural extraction is pinned in
the script so adjacent runs cannot disagree on field labels.

### Diagnostics

From `app_diagnostics`: `provision_status`, `fail_count`, `last_error`. Plain
English interpretation of `provision_status`.

### Recent logs

From `get_logs`: the full log tail in a fenced code block. If logs are empty,
say so.

### Saved manifest (only if present)

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

The script prints a redacted summary (image, size, deployed_at_iso, chain_id,
`meta_hash_hex` for schema-v2 wrappers or `meta_hash` for legacy v1, plus
structural counts and env *keys* — never values). If the file does not exist,
the script prints `(no saved manifest for <uuid>)` and this section can be
omitted.

**Do not** read or `cat` the saved-manifest file directly — its
`manifest_json` field can contain user-supplied env values that may be
sensitive. The summarize script is the only safe way to surface its
contents.

## Step 5 — Suggest next steps

Based on what you saw, recommend concrete actions. Common patterns (LLM
judgment is appropriate here — these signals don't map deterministically):

| Signal | Suggestion |
|---|---|
| `provision_status: image_pull_failed` (or similar) + `last_error` mentions registry | Verify the image registry is on the provider's allowlist. Check the digest still exists publicly. Re-deploy with a corrected image via `/manifest-agent:deploy-app`. |
| Repeated container restarts, OOM-like errors in logs | The SKU is too small. Use `mcp__manifest-fred__update_app` with a larger SKU manifest, or close the lease and redeploy with a bigger SKU. |
| `chainState.state` decodes to `LEASE_STATE_CLOSED` or `LEASE_STATE_INSUFFICIENT_FUNDS` | The lease is already gone. No action needed; the saved manifest record can be removed manually if you want a clean slate. |
| `connectionError` / `providerError` populated but lease is `LEASE_STATE_ACTIVE` | Provider transient issue. Try `app_status` again in 30s. Persistent errors → consider `restart_app`. |
| Persistent failure with no recovery path | Offer `mcp__manifest-lease__close_lease` (see Step 6 — gated by PreToolUse hook). |

## Step 6 — close_lease (when offered)

When you offer `close_lease`, include the image AND the estimated tx fee
in the prompt so the user can confirm what they're closing AND what they're
paying. The image is in the saved manifest summary from Step 4 (if
present); if there is no saved record, say "image: (no local record —
chain has the canonical state)".

Estimate the chain tx fee first per the runtime policy:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "close-lease",
  args: ["<LEASE_UUID>"]
})
```

If the estimate fails, surface the error and ask whether to proceed
without one — do not silently skip.

Compute the human-readable fee string with `humanize-fee.cjs` (do NOT
inline the math):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/humanize-fee.cjs" \
  --chain-data-file "$HOME/.manifest-agent/chains/<activeChain>.json" \
  --fee-json '<ESTIMATE.fee.amount as JSON>'
```

Capture the script's stdout as `FEE_HUMAN`. Then ask via `AskUserQuestion`:

> Close the lease for image `<IMAGE>` (uuid `<LEASE_UUID>`)?
> Estimated tx fee: `<FEE_HUMAN>` (gas `<gasEstimate>`).
> Closing frees the credits this lease was reserving. (yes / no)

If the user accepts, call
`mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })` (PreToolUse
will prompt).

**Verify on-chain state after the tx returns** — a successful broadcast
does not guarantee the lease actually transitioned to a terminal state.
Confirm explicitly:

1. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
2. Decode `chainState.state` via the JSON mode (which exposes a
   `terminal` flag — both `LEASE_STATE_CLOSED` and
   `LEASE_STATE_INSUFFICIENT_FUNDS` count as terminal because the chain
   may transition through INSUFFICIENT_FUNDS on a successful close-lease
   before settling on CLOSED):
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int> --json
   ```
3. Branch on `terminal`:
   - **`terminal: true`** → cleanup. Run:
     ```bash
     node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
     ```
     (no-op if the saved manifest record is already gone). Tell the user
     "Lease is terminal on-chain (`<decoded-name>`). Removed local saved
     manifest record."
   - **`terminal: false`** (still `LEASE_STATE_ACTIVE`, `LEASE_STATE_PENDING`,
     etc.) → tell the user: "close_lease tx accepted but lease state is
     still `<decoded-name>`; chain may need a moment to settle. Re-run
     `/manifest-agent:troubleshoot-deployment <LEASE_UUID>` in ~30s to
     recheck. Local saved manifest record NOT removed yet."
   - If `app_status` itself errors out: surface the error and tell the
     user the tx was sent but verification failed. Do NOT remove the
     local manifest record.

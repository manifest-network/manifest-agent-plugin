---
name: troubleshoot-deployment
description: >
  Diagnose a deployed Manifest lease that isn't behaving. Use when a
  /manifest-agent:deploy-app run shows the app unhealthy, when an
  existing lease stops responding, or when the user wants a
  status-plus-logs snapshot for an arbitrary lease. Optional argument:
  a lease UUID (omit to pick from active leases or saved post-deploy
  records). Bundles app status, provider diagnostics, and recent
  container logs into a single Markdown report; suggests next steps;
  optionally offers close_lease to reclaim a lease beyond recovery.
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

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly.

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

Produce a unified Markdown report with `### Status`, `### Diagnostics`,
`### Recent logs`, and (when present) `### Saved manifest` sections by
piping the gathered data through the report renderer. The script handles
the typed-shape extraction (lease state decode + `Terminal: yes/no` flag,
connection URL walk, provision-status / fail-count / last-error formatting,
log-tail rendering) so adjacent runs can't disagree on field labels.

First, capture the saved-manifest summary if one exists (the script
prints a redacted summary — image, size, deployed_at_iso, chain_id,
`meta_hash_hex`, structural counts, env *keys* — never values). It
prints `(no saved manifest for <uuid>)` when absent:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

Capture stdout as `SAVED_SUMMARY`. If it starts with `(no saved manifest`,
set `SAVED_SUMMARY = ""` so the renderer omits the section.

Then render the full report. Pipe a JSON object with all three MCP
responses + the saved summary on stdin:

```bash
echo '{"app_status":<app_status JSON>, "app_diagnostics":<app_diagnostics JSON>, "get_logs":<get_logs JSON>, "saved_manifest":"<SAVED_SUMMARY escaped as a JSON string>"}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-troubleshoot-report.cjs"
```

**Print the script's stdout verbatim.** Do not paraphrase, do not splice
in extra fields; the script owns the canonical Markdown.

**Do not** read or `cat` the saved-manifest file directly — its
`manifest_json` field can contain user-supplied env values that may be
sensitive. `summarize-manifest.cjs` is the only safe way to surface its
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

## Step 6 — Offer close_lease cleanup

Set up the inputs for the shared billing-tx confirm reference:

- `<estimate-subcommand>` = `"close-lease"`
- `<estimate-args>` = `["<LEASE_UUID>"]`
- `<broadcast-call>` = `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`
- `<prompt-body>` (rendered before the estimated-fee line the reference
  appends) = the image-aware close prompt:
  > Close the lease for image `<IMAGE>` (uuid `<LEASE_UUID>`)?
  > Closing frees the credits this lease was reserving.

  The image comes from the saved manifest summary in Step 4. If there is
  no saved record, render `<IMAGE>` as `(no local record — chain has the
  canonical state)`.

Then `Read` `references/billing-tx-confirm.md` (plugin-root shared
reference; same file is loaded by manage-domain Step 6 and deploy-app's
post-failure cleanup) and follow Steps 1–4 (the estimate, fee
humanization, textual confirm, and broadcast). The PreToolUse hook will
prompt — that's expected.

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

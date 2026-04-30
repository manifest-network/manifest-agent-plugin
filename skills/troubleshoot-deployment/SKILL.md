---
name: troubleshoot-deployment
description: >
  Bundle app status, diagnostics, and recent logs into a unified report for a
  deployed lease. Use to debug failing or stuck apps, or to confirm a
  deployment is healthy. Optionally offers close_lease to reclaim a lease
  that's beyond recovery.
allowed-tools: Bash(*), Read, mcp__manifest-fred__*, mcp__manifest-lease__*
---

# Troubleshoot Deployment

You are producing a unified troubleshooting report for a deployed app on
Manifest. Bundle status, diagnostics, and recent logs into a single Markdown
report and suggest next steps.

**For all user choices in this skill, use the AskUserQuestion tool.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Determine the lease UUID

The lease UUID may have been passed in by a calling skill (e.g.
`/manifest-agent:deploy-app` invokes this on failure). If you have it from the
caller, skip ahead to Step 2.

Otherwise, get the lease UUID:

1. Read the MCP resource `manifest://leases/active`. If it returns one or more
   leases, present them via AskUserQuestion (show lease UUID, image, size, and
   created-at when available). Let the user pick one.
2. If the resource is empty, fall back to listing saved manifests:
   ```bash
   ls "$HOME/.manifest-agent/manifests/"*.json 2>/dev/null
   ```
   For each file, the basename (without `.json`) is the lease UUID. Read each
   file and extract only `image`, `size`, and `deployed_at_iso` for the picker.
   The file may contain sensitive env values inside `manifest_json` — do not
   echo the full file contents into chat. Present via AskUserQuestion.
3. If there are no saved manifests either, tell the user:
   > No active leases found. If you know the lease UUID, paste it now;
   > otherwise there's nothing to troubleshoot.

   Wait for the UUID. If the user doesn't have one, stop.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Choose log tail

Use AskUserQuestion to ask how many recent log lines to fetch:

- **50** — quick scan
- **100** (default) — typical debugging
- **500** — deep dive

Store as `TAIL`.

## Step 3 — Gather data (parallel)

Make these three MCP calls in parallel (single message, three tool calls):

- `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__app_diagnostics({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__get_logs({ lease_uuid: LEASE_UUID, tail: TAIL })`

If any of the three fails, capture the error and continue with the others —
partial information is better than nothing.

## Step 4 — Render the report

Produce a unified Markdown report with these sections:

### Status

- `lease_uuid`, `chainState.state` (decode the integer to its `LEASE_STATE_*`
  name when known), `chainState.providerUuid`.
- If `connection` is present: extract the URL(s) and connection details.
- If `providerError` or `connectionError` is present: surface them prominently.
- If `fredStatus` is present: include any non-empty fields.

### Diagnostics

- `provision_status`, `fail_count`, `last_error`.
- Plain English interpretation of `provision_status`.

### Recent logs

- The full log tail in a fenced code block.
- If logs are empty, say so.

### Saved manifest (only if present)

If `$HOME/.manifest-agent/manifests/<LEASE_UUID>.json` exists, read it but
surface only the non-sensitive wrapper fields: `image`, `size`,
`deployed_at_iso`, `chain_id`, `meta_hash`. **Do not** pretty-print the inner
`manifest_json` into chat — it can contain user-supplied env values that may
be sensitive (DB URLs, API tokens, etc.). If the user wants a structural view
of the manifest, summarize without values: service count, exposed-port count,
and the *keys* (never values) of any env entries.

If the file does not exist, omit this section. (The lease may not have been
deployed by this plugin, or the saved manifest may have been cleaned up.)

## Step 5 — Suggest next steps

Based on what you saw, recommend concrete actions. Common patterns:

| Signal | Suggestion |
|---|---|
| `provision_status: image_pull_failed` (or similar) + `last_error` mentions registry | Verify the image registry is on the provider's allowlist. Check the digest still exists publicly. Re-deploy with a corrected image via `/manifest-agent:deploy-app`. |
| Repeated container restarts, OOM-like errors in logs | The SKU is too small. Use `mcp__manifest-fred__update_app` with a larger SKU manifest, or close the lease and redeploy with a bigger SKU. |
| `chainState.state` is a terminal closed/expired state | The lease is already gone. No action needed; the saved manifest can be removed manually if you want a clean slate. |
| `connectionError` / `providerError` populated but lease is `LEASE_STATE_ACTIVE` | Provider transient issue. Try `mcp__manifest-fred__app_status` again in 30s. Persistent errors → consider `restart_app`. |
| Persistent failure with no recovery path | Offer `mcp__manifest-lease__close_lease` to reclaim the lease (gated by PreToolUse hook). |

If the user accepts a `close_lease` offer and the call succeeds, run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid LEASE_UUID
```
to clean up the saved manifest file. This is a no-op if the file isn't there.

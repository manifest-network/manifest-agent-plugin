---
name: troubleshoot-deployment
description: >
  Bundle app status, diagnostics, and recent logs into a unified report for a
  deployed lease. Use to debug failing or stuck apps, or to confirm a
  deployment is healthy. Optionally offers close_lease to reclaim a lease
  that's beyond recovery.
allowed-tools: Bash(*), Read
argument-hint: "[lease-uuid]"
---

# Troubleshoot Deployment

You are producing a unified troubleshooting report for a deployed app on
Manifest. Bundle live chain state + provider diagnostics + recent logs into a
single Markdown report and suggest next steps.

**For all user choices in this skill, use the `AskUserQuestion` tool.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code and stop.

## Step 1 — Determine the lease UUID

Branches in priority order:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty string that looks
   like a UUID, use it directly. Skip ahead to Step 2.
2. **From the calling skill**: if `/manifest-agent:deploy-app` invoked this
   skill on failure, it will have passed `LEASE_UUID` in context. Use it.
3. **From `manifest://leases/active` MCP resource**: read the resource. If
   it returns one or more leases, present them via `AskUserQuestion` (show
   lease UUID, image, size, created-at when available). Let the user pick
   one.
4. **Fallback to saved manifests**: if the resource is empty or unavailable,
   list saved post-deploy records:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```

   The script prints a JSON array of `{ lease_uuid, image, size, deployed_at_iso, chain_id }`
   — never `manifest_json`. Present via `AskUserQuestion`.
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

From `app_status`:
- `lease_uuid`, `chainState.providerUuid`.
- Decode `chainState.state` (integer) to its canonical name:

  ```bash
  node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int>
  ```

  Surface the human name (`LEASE_STATE_ACTIVE`, etc.) alongside the integer.
- If `connection` is present: extract URL(s) and connection details.
- If `providerError` or `connectionError` is present: surface them
  prominently.
- If `fredStatus` is present: include any non-empty fields.

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
meta_hash, plus structural counts and env *keys* — never values). If the
file does not exist, the script prints `(no saved manifest for <uuid>)` and
this section can be omitted.

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
| Persistent failure with no recovery path | Offer `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })` to reclaim the lease (gated by PreToolUse hook). |

If the user accepts a `close_lease` offer and the call succeeds, run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

The script is a no-op if the saved manifest record is already gone.

---
description: >
  Restart a deployed app on Manifest via the provider, without closing
  its lease. Useful to apply config changes or recover from a crash.
  Optional argument: a lease UUID (omit to pick from active leases or
  saved post-deploy records). Goes through textual confirmation and
  the PreToolUse permission prompt; verifies post-restart status by
  re-querying app_status.
allowed-tools: Bash(*), Read
---

# Restart App

You are restarting a running Manifest app via its provider. The lease
stays open; the container is signaled to stop and start again. The tx
is a broadcast (gas only, no fee estimate available because
`restart_app` is not estimable).

**For all user choices in this skill, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 4") are scaffolding for skill authors only.
To the user, just describe what you're doing in plain language — e.g.
"I'll show you the lease status, then ask you to confirm before
broadcasting", not "Now in Step 2". Skip phrases like "Now in Step N"
or "Branching to..."; describe the action itself.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart
Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first
and stop. Otherwise parse the JSON; you need `activeChain` for the
mainnet warning in Step 3.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly.

## Step 1 — Pick the lease

Branches in priority order, mirroring `manage-domain` Step 3 and
`troubleshoot-deployment` Step 1:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty UUID-shaped
   string, use it directly. Validate against the strict UUID pattern
   (8-4-4-4-12 lowercase hex with dashes — the canonical regex lives
   in `scripts/_uuid.cjs`); reject anything else with a clear error.
2. **From `manifest://leases/active` MCP resource**: read the resource.
   If it returns one or more leases, present them via `AskUserQuestion`
   (lease UUID, image, size). Let the user pick.
3. **Fallback to saved manifests**:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   Each entry includes `lease_uuid, image, size, deployed_at_iso` —
   surface those in the picker.
4. **Last resort**: ask the user to paste a UUID. Validate against the
   UUID regex before continuing.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Show pre-restart context

Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
Decode the lease state via:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <chainState.state> --json
```

Surface the decoded `name`, the response's `provision_status`, and
(when present) `IMAGE` from the saved-manifest summary:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

If the redacted summary starts with `(no saved manifest`, render
`<IMAGE>` as `(unknown — no local record)`.

If `terminal === true` (the lease is closed or out of credits), refuse
and stop:
> Lease `<LEASE_UUID>` is `<decoded-name>`; `restart_app` requires an
> ACTIVE lease. Use `/manifest-agent:deploy-app` to redeploy.

## Step 3 — Mainnet warning (if applicable)

If `activeChain === "mainnet"`, ask via `AskUserQuestion`:

> Mainnet warning: restarting on mainnet costs gas and briefly
> interrupts traffic to your app. Continue?

Options: **Yes** / **No**. Stop on No.

## Step 4 — Textual confirm

Use `AskUserQuestion` (Yes / No):

> Restart lease `<LEASE_UUID>` (image `<IMAGE>`)?
> `restart_app` is not estimable — only the gas-only tx fee applies.
> The container will briefly stop and restart at the provider; the
> lease stays open.

Stop on No.

## Step 5 — Broadcast

Call `mcp__manifest-fred__restart_app({ lease_uuid: LEASE_UUID })`.
The PreToolUse permission prompt will fire — that's expected. The
textual confirm in Step 4 is the primary gate per runtime policy; the
permission prompt is a safety net, not a substitute.

If the call throws, surface the error and stop. Do not retry
automatically.

## Step 6 — Post-restart verification

Re-call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
once. Surface the post-restart `chainState.state` (decoded via
`decode-lease-state.cjs --json`), `provision_status`, and `fail_count`.

- If the state is still ACTIVE and `provision_status` looks healthy
  (`provisioned`, `running`, etc.), tell the user the restart was
  accepted and the provider is bringing the container back up. TLS /
  ingress can take a few seconds to settle.
- If `provision_status` reports a failure or the lease state regressed,
  tell the user the tx was sent but the provider's post-restart status
  shows `<provision_status>` (and `fail_count: <n>`); suggest
  `/manifest-agent:troubleshoot-deployment <LEASE_UUID>` for a full
  status + diagnostics + logs report.

Do not poll. One verify pass is enough; the user can re-run this skill
or troubleshoot-deployment if they want a fresher snapshot.

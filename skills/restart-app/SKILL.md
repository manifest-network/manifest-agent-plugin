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
stays open; the container is signaled to stop and start again.
`restart_app` is an HTTPS call to the provider — NOT a Cosmos
transaction. There is no on-chain broadcast, no gas, and no fee
estimate. The PreToolUse permission prompt still fires (the runtime
policy gates it) and a textual confirmation is still required, but do
not query balances or call `cosmos_estimate_fee` for this skill.

**For all user choices in this skill, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers (e.g. "Step 4") are scaffolding for skill authors only.
To the user, just describe what you're doing in plain language — e.g.
"I'll show you the lease status, then ask you to confirm before
restarting", not "Now in Step 2". Skip phrases like "Now in Step N"
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

> Mainnet warning: restarting on mainnet briefly interrupts traffic to
> your app while the provider stops and starts the container.
> Continue?

Options: **Yes** / **No**. Stop on No.

(No "costs gas" wording — `restart_app` is a provider HTTPS call, not
a Cosmos broadcast; the user is not paying gas for it.)

## Step 4 — Textual confirm

Use `AskUserQuestion` (Yes / No):

> Restart lease `<LEASE_UUID>` (image `<IMAGE>`)?
> The container will briefly stop and restart at the provider; the
> lease stays open. This is an HTTPS call to the provider, not an
> on-chain transaction — no gas is spent and no fee estimate applies.

Stop on No.

## Step 5 — Call the provider

Call `mcp__manifest-fred__restart_app({ lease_uuid: LEASE_UUID })`.
The PreToolUse permission prompt will fire — that's expected (the
matcher in `hooks/hooks.json` gates `restart_app` even though it's
not a Cosmos broadcast, because it's still a state-changing
operation). The textual confirm in Step 4 is the primary gate per
runtime policy; the permission prompt is a safety net, not a
substitute.

If the call throws, surface the error and stop. Do not retry
automatically.

## Step 6 — Post-restart verification

Re-call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
once. Capture the response; extract `chainState.state` (integer) as
`STATE_INT`, plus `provision_status` and `fail_count` for the
provider-side narrative (the driver doesn't handle those — see below).

The structural state check goes through the shared verify-recover
driver (`scripts/verify-recover.cjs`; see `references/verify-recover.md`
for the spec contract). `Read` `references/verify-recover.md` if you
haven't yet. Build the envelope and run:

```bash
echo '{
  "spec": {
    "verifier": { "script": "decode-lease-state.cjs",
                  "args": ["--state", "{{state_int}}", "--json"],
                  "stdin_source": null },
    "success": { "field": "name", "values": ["LEASE_STATE_ACTIVE"] },
    "branches": {
      "other": { "branch_id": "restart-state-not-active",
                 "journal_action_tag": "restart-post-verify-not-active",
                 "user_message": "Restart was sent but lease state is now `{{name}}`. Run `/manifest-agent:troubleshoot-deployment {{lease_uuid}}` for a full diagnostics report." }
    }
  },
  "payloads": {},
  "context": { "state_int": "<STATE_INT>", "lease_uuid": "<LEASE_UUID>" }
}' | node "$MANIFEST_PLUGIN_ROOT/scripts/verify-recover.cjs"
```

Capture the driver's stdout as `VERIFY_RESULT`. Branch on
`VERIFY_RESULT.result`:

- **`success`** (state is ACTIVE): surface `provision_status` and
  `fail_count` from the `app_status` response in plain prose. If
  `provision_status` looks healthy (`provisioned`, `running`, etc.),
  tell the user the restart was accepted and the provider is bringing
  the container back up. TLS / ingress can take a few seconds to
  settle. If `provision_status` itself reports a failure even while
  the chain state is ACTIVE, tell the user the chain registered the
  restart but the provider reports `<provision_status>` (and
  `fail_count: <n>`); suggest
  `/manifest-agent:troubleshoot-deployment <LEASE_UUID>` for a full
  report.
- **`failure`** (branch_id `restart-state-not-active`): print
  `VERIFY_RESULT.user_message` verbatim. The chain state has regressed
  (closed, insufficient funds, etc.) — the driver's message already
  points the user at troubleshoot-deployment.

Do not poll. One verify pass is enough; the user can re-run this skill
or troubleshoot-deployment if they want a fresher snapshot.

## Step 7 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "restart-app",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "restart lease <LEASE_UUID> (image <IMAGE>)",
  "tool_calls": [
    {
      "tool": "mcp__manifest-fred__app_status",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>" },
      "outcome": "ok",
      "result_summary": { "pre_state": "<decoded-name from Step 2>", "pre_provision_status": "<from Step 2>" }
    },
    {
      "tool": "mcp__manifest-fred__restart_app",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>" },
      "outcome": "<ok|error>"
    },
    {
      "tool": "mcp__manifest-fred__app_status",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>" },
      "outcome": "ok",
      "result_summary": { "post_state": "<VERIFY_RESULT.verifier_outcome — decoded state name>", "post_provision_status": "<from Step 6 app_status response>", "fail_count": "<n>" }
    }
  ],
  "outcome": "<'success' if Step 5 broadcast did not throw AND VERIFY_RESULT.result === 'success'; otherwise 'failed'>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "restart_app",
    "post_state": "<VERIFY_RESULT.verifier_outcome — decoded state name>",
    "post_provision_status": "<from Step 6>",
    "fail_count": "<n>"
  },
  "errors": [],
  "recovery_actions": <VERIFY_RESULT.journal_action_tags>
}
JOURNAL_EOF
```

If the user cancelled at the Step 3 mainnet warning or the Step 4
textual confirm, set `outcome` to `"cancelled"`, truncate `tool_calls[]`
to just the pre-restart `app_status` call, and reduce `final_state` to
`{ "cancelled_at": "step-3-mainnet-warning" }` or
`{ "cancelled_at": "step-4-confirm" }`. If Step 2's terminal-state
check refused, no journal record is needed (no state change attempted).
Do NOT mention the journal write in your reply to the user.

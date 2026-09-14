---
name: restart-app
description: >
  Restart a deployed app on Manifest via the provider, without closing
  its lease. Useful to apply config changes or recover from a crash.
  Optional argument: a lease UUID (omit to pick from active leases or
  saved post-deploy records). Goes through textual confirmation and
  the PreToolUse permission prompt; verifies post-restart status by
  re-querying app_status.
allowed-tools: Bash(*), Read
---

<!-- Generated from workflows/restart-app.md by ci/build-packages.cjs. -->

# Restart App

You are restarting a running Manifest app via its provider. The lease
stays open; the container is signaled to stop and start again.
`restart_app` is an HTTPS call to the provider — NOT a Cosmos
transaction. There is no on-chain broadcast, no gas, and no fee
estimate. The PreToolUse hook still requests host permission and the
runtime policy calls for a textual confirmation. Do not query balances
or call `cosmos_estimate_fee` for this skill.

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

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

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
   surface those and any `sku_uuid` / `provider_uuid` in the picker.
   Keep the choice keyed by `lease_uuid`; never infer missing SKU IDs
   from `size` on an older record.
4. **Last resort**: ask the user to paste a UUID. Validate against the
   UUID regex before continuing.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Show pre-restart context

Call `mcp__plugin_manifest-agent_manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
Read `structuredContent` or parse its JSON text fallback. Check for
MCP `isError: true` or JSON `error: true`; report a failed status query
and stop before requesting a restart. Capture `chainState.state` as `STATE` (the chain may return integer,
stringy-int, or canonical `LEASE_STATE_*` form depending on the
encoding path). Decode via the canonical helper:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state "$STATE" --json
```

The script's stdout is `{"name":"<LEASE_STATE_*>","terminal":<bool>}`.
Bind `STATE_NAME` to the `name` field. Restart is eligible iff
`STATE_NAME === "LEASE_STATE_ACTIVE"`.

Surface `STATE_NAME`, `fredStatus.provision_status`, and (when
present) `IMAGE` from the saved-manifest summary:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/summarize-manifest.cjs" --lease-uuid "$LEASE_UUID"
```

If the redacted summary starts with `(no saved manifest`, render
`<IMAGE>` as `(unknown — no local record)`.

If `STATE_NAME !== "LEASE_STATE_ACTIVE"`, refuse and stop:
> Lease `<LEASE_UUID>` has chain state `<STATE_NAME>`;
> `restart_app` requires an ACTIVE lease. Use
> `/manifest-agent:deploy-app` to redeploy if the lease has closed,
> or `/manifest-agent:troubleshoot-deployment <LEASE_UUID>` to see
> what state the lease is actually in.

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

Call `mcp__plugin_manifest-agent_manifest-fred__restart_app({ lease_uuid: LEASE_UUID })`.
The PreToolUse hook requests host permission before execution. Step 4 supplies the action recap; the hook cannot verify that prose or the user's response.

`restart_app` returns JSON text `{ lease_uuid, status }`; it does not
wait for the app to become ready. Check for `isError: true` / `error:
true` even when the host does not throw. Capture the returned status
as `RESTART_STATUS`. On error or a lost response, report the code/message
and the uncertain outcome, then journal the attempted call without
claiming success. Do not retry automatically: each restart call starts
a fresh provider operation.

## Step 6 — Post-restart verification

Re-call `mcp__plugin_manifest-agent_manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
once. After checking for an error envelope, capture `chainState.state`
as `POST_STATE`, plus `fredStatus.provision_status` and
`fredStatus.fail_count`. Decode the state with the same helper as Step 2:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state "$POST_STATE" --json
```

Bind `POST_STATE_NAME` to the `name` field. Interpret the provider and
chain observations together:

- If chain state is ACTIVE and the provider reports `ready` or `running`,
  report the restart response (`RESTART_STATUS`) and current provider
  status. This single snapshot does not prove that the restart cycle
  completed; describe the observed state without making that claim.
- If chain state is ACTIVE but provisioning is still underway, report
  the restart response and current phase. Keep readiness unconfirmed.
- If the provider reports `failed`, surface `fredStatus.reason` and
  `fredStatus.message` when present, with `fail_count`, and suggest
  `/manifest-agent:troubleshoot-deployment <LEASE_UUID>`. An unknown
  reason is still useful; pass through its message. A reason retained
  alongside a healthy current status may describe an earlier failed
  update, so its presence alone does not establish current failure.
- If chain state is no longer ACTIVE, report the actual state and suggest
  troubleshooting. The restart call did not itself change chain state.
- If the query fails or provider data is missing, report verification as
  unavailable, including `providerError` / `connectionError` when present.
  Missing fields are not healthy defaults.

Bind `JOURNAL_RECOVERY_ACTIONS` to a concise applicable tag such as
`restart-readiness-unconfirmed`, `restart-provider-failed`,
`restart-post-verify-not-active`, or `restart-verification-unavailable`;
use an empty array when the provider reports healthy status on ACTIVE.

Do not poll or repeat the restart. The user can request a later status
check; diagnose the existing lease before proposing another mutation.

## Step 7 — Record this run in the journal

The `tool_calls[].tool` strings below are historical journal keys used by
`_journal.cjs` redaction reducers. Keep their `mcp__manifest-*` spelling;
invoke tools with the scoped `mcp__plugin_manifest-agent_manifest-*`
names shown in the workflow above. Journal keys are not callable host names.

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
      "result_summary": { "pre_state": "<decoded-name from Step 2>", "pre_provision_status": "<Step 2 fredStatus.provision_status or null>" }
    },
    {
      "tool": "mcp__manifest-fred__restart_app",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>" },
      "outcome": "<ok|error>",
      "result_summary": { "status": "<RESTART_STATUS or null>" }
    },
    {
      "tool": "mcp__manifest-fred__app_status",
      "args_redacted": { "lease_uuid": "<LEASE_UUID>" },
      "outcome": "<ok|error>",
      "result_summary": { "post_state_name": "<POST_STATE_NAME from decode-lease-state.cjs in Step 6>", "post_provision_status": "<Step 6 fredStatus.provision_status or null>", "fail_count": "<fredStatus.fail_count or null>" }
    }
  ],
  "outcome": "<success|partial|failed|cancelled per guidance below>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "restart_app",
    "post_state_name": "<POST_STATE_NAME>",
    "post_provision_status": "<Step 6 fredStatus.provision_status or null>",
    "fail_count": "<fredStatus.fail_count or null>"
  },
  "errors": [],
  "recovery_actions": <JOURNAL_RECOVERY_ACTIONS from Step 6>
}
JOURNAL_EOF
```

Use `success` when the restart returned successfully and the one status
snapshot reports ACTIVE with a healthy provider; this records acceptance
and the observed state, not proof of a completed restart cycle. Use
`partial` for a successful restart response with readiness still pending
or verification unavailable, and `failed` for a tool error or observed
provider/chain failure. Include the concise error code/message in
`errors` without copying the envelope's `input`. Keep the lease UUID in
all attempted runs. Only include calls actually executed: if Step 5
failed, omit the Step 6 status call. Host denial before Step 5 is
`cancelled` and has no executed restart call.

If the user cancelled at the Step 3 mainnet warning or the Step 4
textual confirm, set `outcome` to `"cancelled"`, truncate `tool_calls[]`
to just the pre-restart `app_status` call, and reduce `final_state` to
`{ "cancelled_at": "step-3-mainnet-warning" }` or
`{ "cancelled_at": "step-4-confirm" }`. If Step 2's terminal-state
check refused, no journal record is needed (no state change attempted).
Do NOT mention the journal write in your reply to the user.

---
name: troubleshoot-deployment
description: >
  Diagnose a deployed Manifest lease that isn't behaving. Use when a
  /manifest-agent:deploy-app run shows the app unhealthy, when an
  existing lease stops responding, or when the user wants a
  chain-state diagnostic report for an arbitrary lease. Optional argument:
  a lease UUID (omit to pick from active leases or saved post-deploy
  records). The orchestrated MCP tool produces a unified Markdown
  report; the skill optionally drives close_lease_orchestrated when
  the user wants cleanup.
allowed-tools: Bash(*), Read, Write
---

<!-- Generated from workflows/troubleshoot-deployment.md by ci/build-packages.cjs. -->

# Troubleshoot Deployment

You are producing a unified troubleshooting report for a deployed app on
Manifest. The orchestrated tool `mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated`
(a read-only chain query — no broadcast, zero elicitations) returns live
chain state, lease items, and chain-side guidance as a Markdown report.
Provider diagnostics and logs are separate Fred reads. The skill
resolves the lease UUID, invokes the tool, prints the
report, and (when the user chooses) drives
`mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated` for cleanup.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run `echo "$MANIFEST_PLUGIN_ROOT"`. If empty, tell the user to restart Claude Code so the SessionStart hook runs, then stop. Run
`node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status`; if it
fails, report the diagnostic and stop. Recommend `/manifest-agent:init-agent`
only for an explicitly missing config; preserve and repair an unreadable
or malformed existing config.
Capture `activeChain` and `address` for the journal record (only used
when cleanup actually fires in Step 3).

## Step 1 — Determine the lease UUID

Branches in priority order:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty UUID-shaped
   string, use it directly. The orchestrated tool re-validates as a
   UUID inside its `inputSchema`, so don't pre-check.
2. **From `manifest://leases/active` MCP resource**: read the resource.
   If it returns one or more leases, present them via `AskUserQuestion`
   (UUID, state, provider UUID and creation time). Include a
   "Lookup by custom domain" option in the
   same picker.
3. **Fallback to saved manifests**: if the resource is empty or
   unavailable, list saved post-deploy records:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   The script prints a JSON array of `{ lease_uuid, image, size,
   deployed_at_iso, chain_id, format?, meta_hash_hex?, schema_version?,
   sku_uuid?, provider_uuid?, custom_domain?, custom_domain_service_name? }`.
   Surface `sku_uuid`, `provider_uuid`, and `custom_domain` in the picker
   when present. Keep the choice keyed by `lease_uuid`; never infer missing SKU IDs
   from `size` on an older record. Include the
   "Lookup by custom domain" option here too.
4. **Lookup by custom domain**: when the user picks this option, ask
   for the FQDN, then call:
   ```
   mcp__plugin_manifest-agent_manifest-agent__lookup_custom_domain_orchestrated({ fqdn: <fqdn> })
   ```
   Read successful `structuredContent` or its JSON text fallback and
   use `lease.leaseUuid` as `LEASE_UUID`. If `lease` is null, surface
   that and fall back to options 3/5. An `isError: true` / `error: true`
   response is a failed lookup, not evidence that no lease exists.
5. **Last resort**: tell the user no leases found; ask them to paste a
   UUID. If they don't have one, stop.

The Fred resource JSON contains `active[]` and `pending[]` arrays.
Each summary has `uuid`, `state`, `provider_uuid`, and `created_at`; it
does not contain image, size, service inventory, or custom domains. Show
the returned fields and use `uuid` as the picker value. Enrich from a
matching saved record only when available, labeling it as a local snapshot.
Do not invent missing values or interpret resource failure as an empty
account; use the saved-record/manual fallback. The resource is a bounded
snapshot, not a guarantee that every historical lease is listed.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Invoke the orchestrated tool + print the report

Call:

```
mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated({ lease_uuid: LEASE_UUID })
```

The tool runs a pure chain query — no broadcast, no elicitation — and
returns `TroubleshootReport { markdown: string }` in `structuredContent`
and a JSON text fallback. Check for MCP `isError: true` or JSON
`error: true` before treating a response as success. **Print the
`markdown` field verbatim** to the user. Do NOT paraphrase, splice in
extra sections, or attempt to compose your own suggestion table —
`agent-core` owns the chain report contents. It does not query provider
health or logs. When the user's diagnostic request needs those, call
`mcp__plugin_manifest-agent_manifest-fred__app_status`,
`mcp__plugin_manifest-agent_manifest-fred__app_diagnostics`, or
`mcp__plugin_manifest-agent_manifest-fred__get_logs` with the lease UUID
as appropriate, and present their findings separately. For app status,
provider fields are under `fredStatus`; unavailable provider data is
reported by `providerError` / `connectionError`. A chain ACTIVE state
alone does not establish application health.

On a diagnostic error envelope or host exception, report the code and
message. Do not start cleanup in response to a failed diagnostic.

## Step 3 — Offer cleanup

After printing the report, ask the user via `AskUserQuestion` whether to
close the lease:

> End lease `<LEASE_UUID>` and its reservation? An active lease will be
> closed, a pending lease will be cancelled, and a terminal lease needs
> no further stop transaction. The original lease cannot be reopened.

Options: **Close** / **Keep**. On **Keep**, stop without writing a
journal record (the troubleshoot flow remains read-only when no
cleanup fires — matches the pre-rewire posture).

On **Close**, invoke:

```
mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated({ lease_uuid: LEASE_UUID })
```

Claude Code evaluates the PreToolUse hook before this outer invocation starts. A denied call does not reach the MCP server.

The server requests native action
confirmation through MCP elicitation, performs the applicable stop
operation, and verifies the terminal chain state. The close recap does not guarantee a
numeric fee estimate. Claude Code renders the elicitation request
and returns the user's answer; do not reprint its message, forward the
answer yourself, or add another prose confirmation. The earlier Close /
Keep choice selects the cleanup action. Internal SDK operations do not
trigger additional PreToolUse events.

Check for an error envelope before capturing successful `CLOSE_RESULT`
(`{ leaseUuid, finalState }`). Report the exact terminal state;
`LEASE_STATE_REJECTED` or `LEASE_STATE_EXPIRED` must not be relabelled
as `LEASE_STATE_CLOSED`. The original lease stays terminal even if
the provider retains volumes that a separate `restore_app` operation
can adopt into a new paid lease.

On error, report the code/message. `OPERATION_CANCELLED` identifies
cancellation; `INVALID_CONFIG` identifies bad input/configuration.
A verification or transport error may follow a completed stop operation.
Preserve the lease UUID, report the unconfirmed outcome, and inspect
the existing lease before proposing another write. Do not automatically
retry cleanup, restore retained volumes, or deploy a replacement.

## Step 4 — Record this run in the journal (cleanup-fire branch only)

The `tool_calls[].tool` strings below are historical journal keys used by
`_journal.cjs` redaction reducers. Keep their `mcp__manifest-*` spelling;
invoke tools with the scoped `mcp__plugin_manifest-agent_manifest-*`
names shown in the workflow above. Journal keys are not callable host names.

If `close_lease_orchestrated` actually fired in Step 3, append one
record to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` with TWO
`tool_calls[]` entries — the diagnostic preceding the close is part
of the audit trail. The writer auto-fills `timestamp_iso`,
`timestamp_unix`, `schema_version`, and `session_id`. `args_redacted`
for both tools is produced by `scripts/_journal.cjs#redactArgs` (the
single-field `{ leaseUuid }` reducer covers both). Internal close and
verification operations live in agent-core and are not enumerated as
host tool calls.

Set `outcome` to `"success"` when both calls returned successful
results. Set `"failed"` for a cleanup error and `"cancelled"` for
`OPERATION_CANCELLED` or host permission denial. A failed verification
does not prove that cleanup was not applied; retain `LEASE_UUID` and
the known terminal state only when reported. Add the error code and
concise safe message to `errors`, without the envelope's `input`.
If host permission was denied, omit the unexecuted close call from
`tool_calls`. Read-
only invocations (the user picked **Keep** in Step 3) do NOT write a
journal record — matches today's posture.

Do NOT mention the journal write in your reply to the user.

Build the redacted record as an object with this shape. The placeholders
describe values, not serialized JSON; use actual booleans, arrays and nulls
where indicated. Never substitute runtime values into shell source.

```text
{
  "skill": "troubleshoot-deployment",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<brief paraphrase of the user's request — no secrets>",
  "plan_summary": "troubleshoot + close-lease on <LEASE_UUID>",
  "tool_calls": [
    {
      "tool": "mcp__manifest-agent__troubleshoot_deployment_orchestrated",
      "args_redacted": { "leaseUuid": "<LEASE_UUID>" },
      "outcome": "ok"
    },
    {
      "tool": "mcp__manifest-agent__close_lease_orchestrated",
      "args_redacted": { "leaseUuid": "<LEASE_UUID>" },
      "outcome": "<ok|error>",
      "result_summary": { "finalState": "<CLOSE_RESULT.finalState or null>" }
    }
  ],
  "outcome": "<success|failed|cancelled>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "close_lease",
    "final_state_name": "<CLOSE_RESULT.finalState or null>",
    "verified": <true if outcome === 'success' else false>
  },
  "errors": [],
  "recovery_actions": []
}
```

Create a private temporary directory with `mktemp -d` and capture its returned
path as `JOURNAL_DIR`. Use the **Write tool** to create a **new** file
`journal.json` inside that directory containing the complete redacted record as
JSON, correctly encoding every string. Do not create the file beforehand and
do not use `mktemp -u`. The directory is mode `0700`; the host may create the
file at `0644`, but the private parent prevents other users from accessing it.

Never paste the record, its fields, or tool responses into a Bash
command, heredoc, or `echo`. Redaction does not make user or registry text safe
shell code. Bind `JOURNAL_DIR` to the returned directory as a properly
shell-escaped literal in the same Bash call below; shell variables do
not persist across calls. Pass the file through stdin and clean up only this
staging file and directory, preserving the writer's exit status:

```bash
JOURNAL_PATH="$JOURNAL_DIR/journal.json"
journal_status=0
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" < "$JOURNAL_PATH" || journal_status=$?
rm -f -- "$JOURNAL_PATH" || true
rmdir -- "$JOURNAL_DIR" || true
exit "$journal_status"
```

Also remove the staging file (if created) and directory on cancellation or
Write failure. If appending fails, report the journal diagnostic
without repeating the underlying operation; a journal failure does not undo
completed work.

---
name: manage-domain
description: >
  Set, clear, or look up the custom domain (FQDN) attached to a Manifest
  lease item. Use after a lease exists when the user wants to attach a
  hostname, free a reservation, or reverse-resolve which lease owns an
  FQDN. With no argument, asks which action and which lease. With a
  lease UUID argument, treats it as the target for set/clear. Lookup is
  a read-only orchestrated chain query; set and clear flow through the
  orchestrated MCP tool, which requests native action confirmation,
  broadcasts, and verifies on-chain state.
allowed-tools: Bash(*), Read, Write
---

<!-- Generated from workflows/manage-domain.md by ci/build-packages.cjs. -->

# Manage Custom Domain

You are setting, clearing, or looking up a custom domain on a Manifest
lease item. Custom domains are claimed permanently on-chain until cleared
or the lease closes; the chain validates format, lowercase, and reserved
suffixes.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run `echo "$MANIFEST_PLUGIN_ROOT"`. If empty, tell the user to restart Claude Code so the SessionStart hook runs, then stop. Run
`node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status`; if it
fails, report the diagnostic and stop. Recommend `/manifest-agent:init-agent`
only for an explicitly missing config; preserve and repair an unreadable
or malformed existing config.
Capture `activeChain` and `address` from the JSON for the journal record.

## Step 1 — Pick the action

Use `AskUserQuestion`:

- **Set** — attach a new FQDN to a lease item.
- **Clear** — remove the FQDN currently attached to a lease item.
- **Lookup** — find which lease currently owns a given FQDN.

Store as `ACTION`. Lookup uses the dedicated read-only orchestrated tool;
set and clear use the mutating orchestrated tool.

## Step 2a — Lookup branch (read-only)

If `ACTION === "lookup"`, ask the user for the FQDN to look up. Then call:

```
mcp__plugin_manifest-agent_manifest-agent__lookup_custom_domain_orchestrated({ fqdn: <fqdn> })
```

This tool performs no broadcast and requests no elicitation.
`manage_domain_orchestrated` accepts only `set` and `clear`.

Read `structuredContent` or parse the JSON text fallback; check for
`isError: true` / `error: true` before interpreting a result. An error
does not mean the domain is unclaimed. The successful result is
`{ action: "lookup", fqdn, lease: { leaseUuid } | null }`:

- If the lease exists, surface `fqdn` and `lease.leaseUuid`. Suggest
  `/manifest-agent:troubleshoot-deployment <leaseUuid>` for its inventory.
  This result does not contain tenant, provider, or service details.
- If `lease` is null, tell the user the FQDN is not
  currently claimed and that `/manifest-agent:manage-domain` → "set"
  can attach it to a lease they own.

Lookup is read-only — do NOT write a journal record. Stop here.

## Step 2b — Set / Clear branch (orchestrated)

If `ACTION === "set"` or `ACTION === "clear"`:

**Resolve `LEASE_UUID`**, in priority order:
1. From `$ARGUMENTS` if non-empty and UUID-shaped (8-4-4-4-12 case-insensitive
   hex with dashes — the strict pattern in `scripts/_uuid.cjs`).
2. From `manifest://leases/active` MCP resource — if it returns one or
   more leases, surface UUID, state, provider UUID and creation time
   via `AskUserQuestion`. Let the user pick.
3. From `list-saved-manifests.cjs`:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   The script prints a JSON array of `{ lease_uuid, image, ..., custom_domain? }`;
   surface that and any `sku_uuid` / `provider_uuid` in the picker.
   Keep the choice keyed by `lease_uuid`; never infer missing SKU IDs
   from `size` on an older record.
4. Ask the user to paste a UUID. Validate against the regex.

The Fred resource JSON contains `active[]` and `pending[]` arrays.
Each summary has `uuid`, `state`, `provider_uuid`, and `created_at`; it
does not contain image, size, service inventory, or custom domains. Show
the returned fields and use `uuid` as the picker value. Enrich from a
matching saved record only when available, labeling it as a local snapshot.
Do not invent missing values or interpret resource failure as an empty
account; use the saved-record/manual fallback. The resource is a bounded
snapshot, not a guarantee that every historical lease is listed.

**Collect FQDN (set only)**: ask the user for the FQDN as a plain string.
Do NOT pre-validate client-side — the orchestrated tool runs
`validateArgs` server-side (RFC 1123 hostname check, scheme rejection,
≤253 chars) and the chain validates reserved-suffix rules.

**Select the lease item for set or clear**: use the lease's service
inventory when available. For multiple items, ask which service is the
target and pass its `serviceName`; clearing is scoped to an item too.
Pass the name for a named service even when it is the only item. Omit it
only for a legacy single item whose service name is empty. If the inventory is unknown,
use `/manifest-agent:troubleshoot-deployment <LEASE_UUID>` to resolve it
before asking the user to choose; do not guess a service.

**Invoke the orchestrated tool**:

```
mcp__plugin_manifest-agent_manifest-agent__manage_domain_orchestrated({
  action: ACTION,
  lease_uuid: LEASE_UUID,
  fqdn: FQDN,          // set only
  service_name: SERVICE_NAME   // use for every named service; omit only for a legacy unnamed item
})
```

Claude Code evaluates the PreToolUse hook before this outer invocation starts. A denied call does not reach the MCP server.

The server requests native
elicitation for the domain action. The pinned tool's action recap does
not guarantee a numeric fee estimate. Claude Code renders
the request and returns the user's answer; do not reprint the message,
forward the answer yourself, or ask for a duplicate prose confirmation.
The internal SDK write does not produce a separate PreToolUse event.
The orchestrated tool verifies the on-chain result and reports mismatches.

Read `structuredContent` or parse the JSON text fallback; check for
`isError: true` / `error: true` before interpreting success. Capture a
successful `MANAGE_RESULT` with shape
`{ action, leaseUuid, verified, finalCustomDomain }`. Surface the action,
lease UUID, verification result, and final domain (`null` when cleared).

For a tool error or host exception, report the code/message. Classify
`OPERATION_CANCELLED` as cancellation; `INVALID_CONFIG` is an input or
configuration failure. A `TX_FAILED` or `QUERY_FAILED` error can occur
after broadcast while verifying the chain, so do not claim the domain
was left unchanged. Query the existing lease before offering a retry;
do not automatically repeat a write or cleanup. If a host cancellation
loses the final response, report the unknown outcome and inspect state.

## Step 3 — Record this run in the journal (set / clear only)

The `tool_calls[].tool` strings below are historical journal keys used by
`_journal.cjs` redaction reducers. Keep their `mcp__manifest-*` spelling;
invoke tools with the scoped `mcp__plugin_manifest-agent_manifest-*`
names shown in the workflow above. Journal keys are not callable host names.

Append one record to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`.
The writer auto-fills `timestamp_iso`, `timestamp_unix`,
`schema_version`, and `session_id`. The single `tool_calls[]` entry is
the orchestrated tool; `args_redacted` is produced by
`scripts/_journal.cjs#redactArgs` (which normalizes snake_case input to
camelCase output: `leaseUuid`, `customDomain`, `serviceName`).
`result_summary` uses `MANAGE_RESULT.verified` and `finalCustomDomain`.
Internal domain writes and verification queries
live in agent-core and are not enumerated as host tool calls.

Set `outcome` to `"success"` only for a successful result with
`verified === true`; use `"partial"` if a successful response reports
`verified === false`. The current server reports verification failures
as errors, not as a mismatch result. Use `"failed"` for other errors
and `"cancelled"` for `OPERATION_CANCELLED` or a host denial. Preserve
`LEASE_UUID` in all attempted runs and record the code plus concise
safe message in `errors`; do not copy the error envelope's `input`.
An error is not evidence of rollback. If permission was denied before
the invocation began, leave `tool_calls` empty.

Do NOT mention the journal write in your reply to the user.

Build the redacted record as an object with this shape. The placeholders
describe values, not serialized JSON; use actual booleans, arrays and nulls
where indicated. Never substitute runtime values into shell source.

```text
{
  "skill": "manage-domain",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<brief paraphrase of the user's request — no secrets>",
  "plan_summary": "<set|clear> domain on lease <LEASE_UUID>, service=<SERVICE_NAME or 'single-item'>",
  "tool_calls": [
    {
      "tool": "mcp__manifest-agent__manage_domain_orchestrated",
      "args_redacted": <reduced via _journal.cjs#redactArgs against the input args>,
      "outcome": "<ok|error>",
      "result_summary": { "verified": "<MANAGE_RESULT.verified or null>", "leaseUuid": "<LEASE_UUID>", "finalCustomDomain": "<MANAGE_RESULT.finalCustomDomain or null>", "serviceName": "<SERVICE_NAME or null>" }
    }
  ],
  "outcome": "<success|partial|failed|cancelled>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "<set|clear>",
    "fqdn": "<MANAGE_RESULT.finalCustomDomain or null>",
    "service_name": "<SERVICE_NAME or null>",
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

**Saved manifest wrapper note (unchanged):** the wrapper at
`$MANIFEST_PLUGIN_DATA/manifests/<LEASE_UUID>.json` is intentionally
NOT refreshed by manage-domain — the on-chain state is canonical.
The wrapper's `custom_domain` may go stale; consumers needing the live
value should query the lease or use
`mcp__plugin_manifest-agent_manifest-agent__lookup_custom_domain_orchestrated`
for reverse lookup. A later deployment creates a new lease and a new
saved record; it does not refresh this lease's historical snapshot.

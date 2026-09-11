---
name: deploy-app
description: >
  Deploy a complete container deployment spec to the Manifest blockchain
  via the orchestrated MCP tool. Argument: path to a spec JSON produced
  by /manifest-agent:author-manifest. Without an argument, points the
  user at /manifest-agent:author-manifest — the orchestrated tool does
  not accept partial specs.
allowed-tools: Bash(*), Read, Write
---

# Deploy App

`mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated` (in the `manifest-agent`
MCP server) owns plan rendering, fee itemization, dual-tx broadcast
(when `customDomain` is set), and partial-success recovery via MCP
elicitation. Your job: load the spec, invoke the tool, render the
typed result, journal the run.

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding only.

## Step 0 — Verify environment

Run `echo "$MANIFEST_PLUGIN_ROOT"`. If empty, tell the user to restart
Claude Code so the SessionStart hook runs, then stop. Run
`node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status`; on
failure tell the user to run `/manifest-agent:init-agent` and stop.
Capture `activeChain`, `address`, and `chainId` from the JSON output —
the journal record needs them in Step 4.

## Step 1 — Resolve the spec

The orchestrated tool requires a **complete** spec. There is no inline
authoring path through this skill.

- If `$ARGUMENTS` is a readable file path, `Read` it and parse the
  contents as JSON → bind as `SPEC`, keeping its absolute path as `SPEC_PATH`.
- Otherwise (empty, image-shaped string, unreadable path) tell the
  user: "I need a complete deployment spec. Run
  `/manifest-agent:author-manifest` to build one interactively, then
  re-run `/manifest-agent:deploy-app <path>` with the saved file."
  Stop without invoking the tool.

`SPEC.size` must be a non-empty SKU name, and exactly one of `image` or
`services` must be present. If an older saved spec omitted `size`, stop
and ask the user to select a SKU through `/manifest-agent:author-manifest`;
do not guess a tier. Preserve any `skuUuid` and `providerUuid` supplied
in the spec: they pin the compute selection even when names repeat. If
the server rejects the selection, report the error; do not remove the IDs
or retry with a name-only spec. Older name-only specs remain supported by
the server's ambiguity checks; never infer or backfill their IDs.
A `services` map requires `serviceName` when `customDomain`
is set, even when the map contains only one service.

When either `storageSkuUuid` or `storageProviderUuid` is present, these are
plugin documentation-only metadata; MCP 0.22.0 does not honor them as
storage selectors. Call `mcp__plugin_manifest-agent_manifest-fred__browse_catalog`
and extract its successful JSON payload from `structuredContent` or the
JSON text fallback. Create a private temporary file with `mktemp` and bind
its returned path as `CATALOG_PATH`. Use the **Write tool** to put the complete
catalog payload there as JSON, encoding string values correctly (including
quotes, backslashes, and newlines). Catalog names are untrusted data; never
paste them or any response content into a Bash command, heredoc, or `echo`.

Read the original spec directly in the helper and redirect the catalog file
to stdin. Only shell-quoted file paths enter the command; no spec or catalog
values are interpolated. Set `SPEC_PATH` and `CATALOG_PATH` to their
shell-quoted paths in the same Bash call; do not assume shell variables
persist from an earlier call:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/check-storage-selection.cjs" \
  --spec-file "$SPEC_PATH" < "$CATALOG_PATH"
```

Remove `CATALOG_PATH` after the check, retaining the helper's exit status.
On catalog error or nonzero helper exit, report the diagnostic and stop
before invoking deployment. Ask the user to revisit the storage choice
through `/manifest-agent:author-manifest`; do not change or remove it
automatically. On success, retain the metadata in the draft and journal.
The check verifies the current catalog; upstream still resolves storage
by name on the compute provider, so this is not an immutable storage pin.
For an older draft without storage identity metadata, skip this check and
leave name resolution to the server; do not invent IDs.

When `storage` is set, disclose before deployment that the catalog and this
check establish identity only, not whether a SKU provides persistent storage.
The choice must come from the provider's documentation. MCP 0.22.0 creates
an additional billed lease item for storage, but its confirmation plan omits
storage pricing and its transaction estimate excludes that item. Do not
describe the displayed plan or estimate as covering storage costs.

## Step 2 — Invoke the orchestrated tool

Call `mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated({ spec: SPEC })`.

Claude Code evaluates the PreToolUse hook for this outer invocation before
starting the tool. If permission is denied, the tool does not run. Once
execution starts, the server requests native MCP elicitation for the
plan with itemized fees, any mainnet warning, and recovery choices.
Claude Code renders these requests and returns the user's answers; do
not reprint their messages, forward answers yourself, or add a separate
prose confirmation. Acknowledge only progress the host actually exposes.

The server's internal SDK operations do not produce additional host
PreToolUse events. Creation, optional domain assignment, and provider
upload run sequentially and can partially succeed. Use the returned
result or error to describe what completed; do not call the workflow
atomic or infer success from a single completed transaction.

## Step 3 — Render the result

Read a successful response from `structuredContent`, or parse its JSON
text fallback. Before treating it as success, check for MCP `isError:
true` or a JSON error envelope with `error: true`; a tool error need not
throw in the host. Capture success as `DEPLOY_RESULT` with shape
`{ leaseUuid, providerUuid, leaseState, urls, customDomain?, manifestPath }`.
Surface:

- Lease: `<leaseUuid>` · Provider: `<providerUuid>` · State: `<leaseState>`
- URL(s): `<urls.join(", ")>` when populated. Otherwise report that no
  public URL was returned; do not infer network isolation from an empty list.
- Custom domain: `<customDomain>` when present
- Saved manifest: `<manifestPath>` when non-empty. Otherwise state that
  the deployment completed but no saved local manifest was reported.
- Follow-up: `/manifest-agent:troubleshoot-deployment <leaseUuid>`

For an error envelope, capture its `code`, `message`, and `details` as
`DEPLOY_ERROR`. Explain the returned outcome using those fields:

- `OPERATION_CANCELLED` without a reported lease or recovery outcome:
  the operation was cancelled. Use an explicit pre-broadcast message to
  state that no transaction was sent; cancellation alone is not proof.
- `DEPLOY_READINESS_UNCONFIRMED` or `details.partial === true`: remote
  work may have completed. Preserve `details.lease_uuid` and any
  transaction hash; report readiness as unconfirmed and diagnose that
  existing lease with `/manifest-agent:troubleshoot-deployment`.
- `OPERATION_CANCELLED` with `details.recovery_outcome ===
  "salvage_without_domain"`: the paid lease was preserved without the
  requested domain. Report partial success and the existing lease UUID.
- `OPERATION_CANCELLED` with recovery outcome `cancel_lease` or
  `close_lease`: the selected cleanup completed. Report `stop_outcome`
  and the authoritative `lease_state`; `already_inactive` means no new
  cleanup transaction. Include `transaction_hash` only when provided.
- Other errors: report the code and message with any known lease UUID.
  A failed tool call does not establish that earlier writes were undone.

The wrapper has already handled its native recovery choice. Do not run
another deployment, close a lease, or retry a write automatically. Each
deployment creates a new paid lease; inspect an existing lease before
deciding what to do next.

If the host cancels the request and provides no final response, use any
exposed server warning (`deploy_cancelled_after_broadcast` or
`recovery_dismissed`) to retain the lease UUID and reported outcome.
Absence of a response or warning does not prove that no lease was
created. Report the uncertainty and check the user's leases before
offering another deployment.

## Step 4 — Record this run in the journal

The `tool_calls[].tool` strings below are historical journal keys used by
`_journal.cjs` redaction reducers. Keep their `mcp__manifest-*` spelling;
invoke tools with the scoped `mcp__plugin_manifest-agent_manifest-*`
names shown in the workflow above. Journal keys are not callable host names.

Append one record to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`.
The writer auto-fills `timestamp_iso`, `timestamp_unix`,
`schema_version`, and `session_id`; the per-tool reducer in
`scripts/_journal.cjs#redactArgs` produces `args_redacted` for the
orchestrated tool (env values reduced to keys-only). Classify the run
from the structured outcome, not whether the host threw:

- `success`: a successful `DEPLOY_RESULT`.
- `partial`: readiness unconfirmed, a partial error, or
  `salvage_without_domain` recovery preserving the lease.
- `cancelled`: cancellation before work, or completed user-selected
  cancel/close recovery. Retain the cleanup's terminal state separately.
- `failed`: other errors, including an unresolved transport failure.

Use the known lease UUID from `DEPLOY_RESULT.leaseUuid`,
`DEPLOY_ERROR.details.lease_uuid`, or an exposed server warning in
`final_state`; never discard it just because success was not returned.
Include only the returned code and a concise message in `errors`, with
safe machine fields such as `recovery_outcome`, `stop_outcome`,
`lease_state`, `transaction_hash`, and `readiness_unconfirmed` in result
summaries/recovery actions. Do not journal the error envelope's `input`
or copy a spec/environment into error prose. A host denial before
execution has no executed tool call; leave `tool_calls` empty.
Do NOT mention the journal write in your reply to the user.

Keep selected compute IDs in `args_redacted` through the reducer. When
storage metadata is present, include `storage_sku_uuid` and
`storage_provider_uuid` from the draft in `final_state` as the requested
storage identity, not proof of the deployed lease item's SKU. Omit them
for legacy drafts. Actual provider identity comes from the tool result.

Build the redacted record as an object with the following shape. The
placeholders describe in-memory values; do not substitute them into shell
source or treat this sketch as already serialized JSON.

```text
{
  "skill": "deploy-app",
  "active_chain": "<activeChain from Step 0>",
  "signer_address": "<address from Step 0>",
  "intent": "<brief paraphrase of the user's request — no secrets>",
  "plan_summary": "deploy spec from <path>, image=<primary image from SPEC>",
  "tool_calls": [
    {
      "tool": "mcp__manifest-agent__deploy_app_orchestrated",
      "args_redacted": <reduced via _journal.cjs#redactArgs against {spec: SPEC}>,
      "outcome": "<ok|error>",
      "result_summary": { "leaseUuid": "<known lease UUID or null>", "providerUuid": "<DEPLOY_RESULT.providerUuid or null>", "url": "<DEPLOY_RESULT.urls[0] or null>", "customDomain": "<DEPLOY_RESULT.customDomain or null>", "manifestPath": "<non-empty DEPLOY_RESULT.manifestPath or null>", "code": "<DEPLOY_ERROR.code or null>", "recovery_outcome": "<reported recovery outcome or null>", "stop_outcome": "<reported stop outcome or null>", "transaction_hash": "<reported transaction hash or null>" }
    }
  ],
  "outcome": "<success|partial|failed|cancelled>",
  "final_state": { "leaseUuid": "<known lease UUID or null>", "providerUuid": "<DEPLOY_RESULT.providerUuid or null>", "leaseState": "<DEPLOY_RESULT.leaseState or reported cleanup lease_state or null>", "manifestPath": "<non-empty DEPLOY_RESULT.manifestPath or null>", "customDomain": "<DEPLOY_RESULT.customDomain or null>", "chain_id": "<chainId from Step 0>", "readiness_unconfirmed": "<reported readiness_unconfirmed or null>" },
  "errors": [{ "class": "<error class>", "mcp_error_code": "<returned code>", "message": "<concise safe error message; omit this object on success>" }],
  "recovery_actions": ["<completed recovery outcome, omit entry when none>"]
}
```

Create a private temporary file with `mktemp` and capture its path as
`JOURNAL_PATH`. Use the **Write tool** to serialize the complete redacted
record to that file as JSON, correctly encoding quotes, backslashes, and
newlines in every string. Redaction removes secrets, but fields such as
`args_redacted.size` still contain provider-controlled catalog data. Never
paste the record, its fields, or tool responses into a Bash command,
heredoc, or `echo`.

Set `JOURNAL_PATH` to its shell-quoted path in the same Bash call; do not
assume shell variables persist from an earlier call. Pass the file to the
writer through stdin:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" < "$JOURNAL_PATH"
```

Remove the temporary file after the call, preserving the writer's exit
status. If appending fails, report the journal diagnostic without
rerunning deployment; a journal failure does not undo the deployed lease.

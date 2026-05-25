---
description: >
  Set, clear, or look up the custom domain (FQDN) attached to a Manifest
  lease item. Use after a lease exists when the user wants to attach a
  hostname, free a reservation, or reverse-resolve which lease owns an
  FQDN. With no argument, asks which action and which lease. With a
  lease UUID argument, treats it as the target for set/clear. Lookup is
  a direct read-only chain query; set and clear flow through the
  orchestrated MCP tool, which estimates the fee, asks the user to
  confirm via elicitation, broadcasts, and verifies on-chain state.
allowed-tools: Bash(*), Read
---

# Manage Custom Domain

You are setting, clearing, or looking up a custom domain on a Manifest
lease item. Custom domains are claimed permanently on-chain until cleared
or the lease closes; the chain validates format, lowercase, and reserved
suffixes.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run `echo "$MANIFEST_PLUGIN_ROOT"`. If empty, tell the user to restart
Claude Code so the SessionStart hook runs, then stop. Run
`node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status`; if it
fails, tell the user to run `/manifest-agent:init-agent` first and stop.
Capture `activeChain` and `address` from the JSON for the journal record.

## Step 1 — Pick the action

Use `AskUserQuestion`:

- **Set** — attach a new FQDN to a lease item.
- **Clear** — remove the FQDN currently attached to a lease item.
- **Lookup** — find which lease (and which service inside it) currently
  owns a given FQDN.

Store as `ACTION`. Lookup is read-only and routes through a direct chain
query; set and clear go through the orchestrated tool.

## Step 2a — Lookup branch (read-only)

If `ACTION === "lookup"`, ask the user for the FQDN to look up. Then call:

```
mcp__manifest-lease__lease_by_custom_domain({ custom_domain: <fqdn> })
```

This is a direct call (not through `manage_domain_orchestrated`) to keep
the read-only path ungated — the orchestrated wrapper is broadcast-gated
by the PreToolUse hook, which would incorrectly prompt for a chain query.
Once `ENG-212` lands and splits lookup into its own MCP tool, this branch
collapses to the orchestrated form.

Render the response:
- If the lease exists, surface `lease.uuid`, `lease.tenant`,
  `lease.providerUuid`, and `service_name`. Suggest
  `/manifest-agent:troubleshoot-deployment <uuid>` for follow-up.
- If the lease is empty / not found, tell the user the FQDN is not
  currently claimed and that `/manifest-agent:manage-domain` → "set"
  can attach it to a lease they own.

Lookup is read-only — do NOT write a journal record. Stop here.

## Step 2b — Set / Clear branch (orchestrated)

If `ACTION === "set"` or `ACTION === "clear"`:

**Resolve `LEASE_UUID`**, in priority order:
1. From `$ARGUMENTS` if non-empty and UUID-shaped (8-4-4-4-12 lowercase
   hex with dashes — the strict pattern in `scripts/_uuid.cjs`).
2. From `manifest://leases/active` MCP resource — if it returns one or
   more leases, surface lease UUID, image, and current `customDomain`
   per item via `AskUserQuestion`. Let the user pick.
3. From `list-saved-manifests.cjs`:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   The script prints a JSON array of `{ lease_uuid, image, ..., custom_domain? }`;
   surface that in the picker.
4. Ask the user to paste a UUID. Validate against the regex.

**Collect FQDN (set only)**: ask the user for the FQDN as a plain string.
Do NOT pre-validate client-side — the orchestrated tool runs
`validateArgs` server-side (RFC 1123 hostname check, scheme rejection,
≤253 chars) and the chain validates reserved-suffix rules.

**Collect service name (stacks only)**: ask via `AskUserQuestion`:
"Is this lease a multi-service stack? If yes, which service does the
domain attach to?" If the lease is single-item, the user picks "single
item lease" and `serviceName` is omitted. If they're unsure, suggest
`/manifest-agent:troubleshoot-deployment <LEASE_UUID>` to see the
service inventory. Skip this question entirely on `clear` unless the
user explicitly needs to scope the clear to one service.

**Invoke the orchestrated tool**:

```
mcp__manifest-agent__manage_domain_orchestrated({
  action: ACTION,
  lease_uuid: LEASE_UUID,
  fqdn: FQDN,          // set only
  service_name: SERVICE_NAME   // optional; stacks only
})
```

While the call runs, the wrapper raises one elicitation prompt with a
text confirmation block (`Set custom domain on lease <uuid>: FQDN: …` or
`Clear custom domain on lease <uuid>: Service: …`). **Print the message
body verbatim** and forward the elicitation response unchanged — do
NOT paraphrase. The orchestrated tool also runs the on-chain verifier
after broadcast and surfaces any mismatch through the same response
shape. The inner `mcp__manifest-lease__set_item_custom_domain`
broadcast triggers the PreToolUse permission prompt on its own — that's
expected.

On non-throw return, capture `MANAGE_RESULT`. The shape is
`ManageDomainResult` — surface its `action`, `leaseUuid`, `fqdn` (set or
the resolved cleared FQDN), `serviceName?`, and `verifier_outcome` to
the user in plain prose. On throw, surface the MCP error envelope
verbatim — the wrapper has already run its verify-and-recover dispatch.

## Step 3 — Record this run in the journal (set / clear only)

Append one record to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`.
The writer auto-fills `timestamp_iso`, `timestamp_unix`,
`schema_version`, and `session_id`. The single `tool_calls[]` entry is
the orchestrated tool; `args_redacted` is produced by
`scripts/_journal.cjs#redactArgs` (which normalizes snake_case input to
camelCase output: `leaseUuid`, `customDomain`, `serviceName`).
`result_summary` mines `MANAGE_RESULT` for `verifier_outcome` plus the
load-bearing fields. Inner `cosmos_estimate_fee` +
`set_item_custom_domain` + `leases_by_tenant` calls live in agent-core
and are NOT enumerated.

Set `outcome` to `"success"` when the orchestrated tool returned non-
throw and the verifier outcome was `match`. Set `"partial"` if the
verifier outcome was `mismatch` (broadcast accepted but chain shows the
wrong value — likely a settling delay). Set `"failed"` for any throw
that isn't a user cancellation. Set `"cancelled"` if the orchestrated
tool threw `INVALID_CONFIG` with a cancellation message
(`User declined to proceed with manage-domain …`).

Do NOT mention the journal write in your reply to the user.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
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
      "result_summary": { "verifier_outcome": "<MANAGE_RESULT.verifier_outcome or null>", "leaseUuid": "<LEASE_UUID>", "customDomain": "<FQDN or null>", "serviceName": "<SERVICE_NAME or null>" }
    }
  ],
  "outcome": "<success|partial|failed|cancelled>",
  "final_state": {
    "lease_uuid": "<LEASE_UUID>",
    "action": "<set|clear>",
    "fqdn": "<FQDN or null>",
    "service_name": "<SERVICE_NAME or null>",
    "verified": <true if outcome === 'success' else false>
  },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

**Saved manifest wrapper note (unchanged):** the wrapper at
`$MANIFEST_PLUGIN_DATA/manifests/<LEASE_UUID>.json` is intentionally
NOT refreshed by manage-domain — the on-chain state is canonical.
The wrapper's `custom_domain` may go stale; consumers needing the live
value should query `mcp__manifest-lease__leases_by_tenant` or
`mcp__manifest-lease__lease_by_custom_domain`. The wrapper refreshes
naturally on the next `/manifest-agent:deploy-app` run for that lease.

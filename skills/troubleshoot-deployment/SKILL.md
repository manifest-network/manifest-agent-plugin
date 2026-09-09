---
description: >
  Diagnose a deployed Manifest lease that isn't behaving. Use when a
  /manifest-agent:deploy-app run shows the app unhealthy, when an
  existing lease stops responding, or when the user wants a
  status-plus-logs snapshot for an arbitrary lease. Optional argument:
  a lease UUID (omit to pick from active leases or saved post-deploy
  records). The orchestrated MCP tool produces a unified Markdown
  report; the skill optionally drives close_lease_orchestrated when
  the user wants cleanup.
allowed-tools: Bash(*), Read
---

# Troubleshoot Deployment

You are producing a unified troubleshooting report for a deployed app on
Manifest. The orchestrated tool `mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated`
(a read-only chain query — no broadcast, zero elicitations) bundles live
chain state + provider diagnostics + recent logs into a single Markdown
report. The skill resolves the lease UUID, invokes the tool, prints the
report, and (when the user chooses) drives
`mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated` for cleanup.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only.

## Step 0 — Verify environment

Run `echo "$MANIFEST_PLUGIN_ROOT"`. If empty, tell the user to restart
Claude Code so the SessionStart hook runs, then stop. Run
`node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status`; if it
fails, tell the user to run `/manifest-agent:init-agent` first and stop.
Capture `activeChain` and `address` for the journal record (only used
when cleanup actually fires in Step 3).

## Step 1 — Determine the lease UUID

Branches in priority order:

1. **From `$ARGUMENTS`**: if `$ARGUMENTS` is a non-empty UUID-shaped
   string, use it directly. The orchestrated tool re-validates as a
   UUID inside its `inputSchema`, so don't pre-check.
2. **From `manifest://leases/active` MCP resource**: read the resource.
   If it returns one or more leases, present them via `AskUserQuestion`
   (lease UUID, image, size, created-at, and `items[].customDomain`
   when non-empty). Include a "Lookup by custom domain" option in the
   same picker.
3. **Fallback to saved manifests**: if the resource is empty or
   unavailable, list saved post-deploy records:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   The script prints a JSON array of `{ lease_uuid, image, size,
   deployed_at_iso, chain_id, format?, meta_hash_hex?, schema_version?,
   custom_domain?, custom_domain_service_name? }`. Surface
   `custom_domain` in the picker labels when present. Include the
   "Lookup by custom domain" option here too.
4. **Lookup by custom domain**: when the user picks this option, ask
   for the FQDN, then call:
   ```
   mcp__plugin_manifest-agent_manifest-lease__lease_by_custom_domain({ custom_domain: <fqdn> })
   ```
   Use the returned `lease.uuid` as `LEASE_UUID`. If the lookup returns
   no lease, surface that and fall back to options 3/5.
5. **Last resort**: tell the user no leases found; ask them to paste a
   UUID. If they don't have one, stop.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Invoke the orchestrated tool + print the report

Call:

```
mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated({ lease_uuid: LEASE_UUID })
```

The tool runs a pure chain query — no broadcast, no elicitation — and
returns `TroubleshootReport { markdown: string }`. **Print the
`markdown` field verbatim** to the user. Do NOT paraphrase, splice in
extra sections, or attempt to compose your own suggestion table —
`agent-core` owns the report contents (status, diagnostics, logs, any
suggestion prose).

On thrown error, surface the MCP error envelope verbatim and stop. No
cleanup branch fires.

## Step 3 — Offer cleanup

After printing the report, ask the user via `AskUserQuestion` whether to
close the lease:

> Close the lease `<LEASE_UUID>` to free its credits and end the
> reservation? Closing is permanent — the lease cannot be reopened.

Options: **Close** / **Keep**. On **Keep**, stop without writing a
journal record (the troubleshoot flow remains read-only when no
cleanup fires — matches the pre-rewire posture).

On **Close**, invoke:

```
mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated({ lease_uuid: LEASE_UUID })
```

Claude Code evaluates the PreToolUse hook on the outer close invocation
before execution. Once allowed, the server requests native action
confirmation through MCP elicitation, broadcasts, and verifies the
terminal chain state. The pinned close recap does not guarantee a
numeric fee estimate. Claude Code renders the elicitation request
and returns the user's answer; do not reprint its message, forward the
answer yourself, or add another prose confirmation. The earlier Close /
Keep choice selects the cleanup action. Internal SDK operations do not
trigger additional host PreToolUse events.

On non-throw return, capture `CLOSE_RESULT` (`{ leaseUuid, finalState }`).
Surface to the user: "Lease `<leaseUuid>` closed; final state
`<finalState>`." On throw, surface the MCP error envelope verbatim.

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

Set `outcome` to `"success"` when both calls returned non-throw. Set
`"failed"` if `close_lease_orchestrated` threw (the diagnostic
succeeded but cleanup didn't). Set `"cancelled"` when the user
declined inside `close_lease_orchestrated`'s elicitation (the wrapper
throws `INVALID_CONFIG` with a cancellation-shaped message). Read-
only invocations (the user picked **Keep** in Step 3) do NOT write a
journal record — matches today's posture.

Do NOT mention the journal write in your reply to the user.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
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
JOURNAL_EOF
```

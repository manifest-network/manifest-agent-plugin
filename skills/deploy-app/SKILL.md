---
description: >
  Deploy a complete container deployment spec to the Manifest blockchain
  via the orchestrated MCP tool. Argument: path to a spec JSON produced
  by /manifest-agent:author-manifest. Without an argument, points the
  user at /manifest-agent:author-manifest — the orchestrated tool does
  not accept partial specs.
allowed-tools: Bash(*), Read
---

# Deploy App

`mcp__manifest-agent__deploy_app_orchestrated` (in the `manifest-agent`
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
  contents as JSON → bind as `SPEC`.
- Otherwise (empty, image-shaped string, unreadable path) tell the
  user: "I need a complete deployment spec. Run
  `/manifest-agent:author-manifest` to build one interactively, then
  re-run `/manifest-agent:deploy-app <path>` with the saved file."
  Stop without invoking the tool.

## Step 2 — Invoke the orchestrated tool

Call `mcp__manifest-agent__deploy_app_orchestrated({ spec: SPEC })`.

While the call runs the wrapper raises MCP elicitation requests
(deployment plan with itemized fees, mainnet warning, partial-success
recovery choice). **Print each prompt's `message` body to the user
verbatim** and forward the elicitation response unchanged — do NOT
paraphrase, summarize, or splice in extra fields; `agent-core` pins
the wording across runs. Stream `notifications/progress` events inline
as they arrive. The inner broadcasts
(`mcp__manifest-fred__deploy_app`,
`mcp__manifest-lease__set_item_custom_domain`) trigger the PreToolUse
permission prompt on their own — that's expected, one prompt per
inner tx.

## Step 3 — Render the result

On non-throw return, capture the response as `DEPLOY_RESULT`. The shape
is `{ leaseUuid, providerUuid, leaseState, urls, customDomain?, manifestPath }`.
Surface:

- Lease: `<leaseUuid>` · Provider: `<providerUuid>` · State: `<leaseState>`
- URL(s): `<urls.join(", ")>` when populated, else `(internal-only — no public ingress)`
- Custom domain: `<customDomain>` when present
- Saved manifest: `<manifestPath>`
- Follow-up: `/manifest-agent:troubleshoot-deployment <leaseUuid>`

On throw, surface the MCP error envelope verbatim. The wrapper has
already run its recovery dispatch (if a `RecoveryChoice` applied) — you
just display the final error.

## Step 4 — Record this run in the journal

Append one record to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`.
The writer auto-fills `timestamp_iso`, `timestamp_unix`,
`schema_version`, and `session_id`; the per-tool reducer in
`scripts/_journal.cjs#redactArgs` produces `args_redacted` for the
orchestrated tool (env values reduced to keys-only). Pass `outcome`
`"success"` on non-throw, `"failed"` on throw, or `"cancelled"` when
the wrapper threw `INVALID_CONFIG` with a cancellation-shaped message
(`User cancelled deployment at plan step.` etc.). Do NOT mention the
journal write in your reply to the user.

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
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
      "result_summary": { "leaseUuid": "<DEPLOY_RESULT.leaseUuid or null>", "providerUuid": "<DEPLOY_RESULT.providerUuid or null>", "url": "<DEPLOY_RESULT.urls[0] or null>", "customDomain": "<DEPLOY_RESULT.customDomain or null>", "manifestPath": "<DEPLOY_RESULT.manifestPath or null>" }
    }
  ],
  "outcome": "<success|failed|cancelled>",
  "final_state": { "leaseUuid": "<DEPLOY_RESULT.leaseUuid or null>", "providerUuid": "<DEPLOY_RESULT.providerUuid or null>", "leaseState": "<DEPLOY_RESULT.leaseState or null>", "manifestPath": "<DEPLOY_RESULT.manifestPath or null>", "customDomain": "<DEPLOY_RESULT.customDomain or null>", "chain_id": "<chainId from Step 0>" },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

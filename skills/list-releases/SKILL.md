---
description: >
  Show the release/version history for a deployed Manifest app.
  Read-only. Optional argument: a lease UUID (omit to pick from active
  leases or saved post-deploy records). Renders a Markdown table sorted
  newest first; rolling back to a prior release is out of scope here.
allowed-tools: Bash(*), Read
---

# List Releases

You are surfacing the on-provider release history for a deployed app.
Read-only — no broadcasts, no state mutation.

**For all user choices in this skill, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Fetching the
release history", not "Now in Step 2 the MCP call".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart
Claude Code so the SessionStart hook runs, then stop.

This skill does not read `update-config.cjs --status` — `app_releases`
is a pure provider call that doesn't need chain-data context.

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
4. **Last resort**: ask the user to paste a UUID. Validate against the
   UUID regex before continuing.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Fetch + render

Call `mcp__manifest-fred__app_releases({ lease_uuid: LEASE_UUID })`,
then pipe the JSON response through the renderer:

```bash
echo '<app_releases response>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-releases.cjs"
```

**Print the script's stdout verbatim.** Do not paraphrase the table or
re-sort the rows; the script owns the canonical Markdown.

## Step 3 — Note about rollback

After the table, append a single-line note:

> Rolling back to a prior release would re-deploy that release's
> manifest payload via `update_app` — that's outside the scope of this
> skill (track separately if needed).

This sets expectations: the table is informational, not a rollback UI.

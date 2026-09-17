---
name: list-releases
description: >
  Show the release/version history for a deployed Manifest app.
  Read-only. Optional argument: a lease UUID (omit to pick from active
  leases or saved post-deploy records). Renders a Markdown table sorted
  newest first; rolling back to a prior release is out of scope here.
allowed-tools: Bash(*), Read, Write
---

# List Releases

You are surfacing the on-provider release history for a deployed app.
Read-only — no broadcasts, no state mutation.

**For all user choices in this skill, use the `{{ask}}` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Fetching the
release history", not "Now in Step 2 the MCP call".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; {{environment_recovery}}.

This skill does not read `update-config.cjs --status`. The read-only
`app_releases` tool uses the configured wallet for provider authentication
and queries the chain to resolve an ACTIVE or PENDING lease and provider.
It fails for a terminal lease or missing provider access; do not describe
such failures as an empty release history.

## Step 1 — Pick the lease

Branches in priority order, mirroring `manage-domain` Step 3 and
`troubleshoot-deployment` Step 1:

1. **From `{{arguments}}`**: if `{{arguments}}` is a non-empty UUID-shaped
   string, use it directly. Validate against the strict UUID pattern
   (8-4-4-4-12 case-insensitive hex with dashes — the canonical regex lives
   in `scripts/_uuid.cjs`); reject anything else with a clear error.
2. **From `manifest://leases/active` MCP resource**: read the resource.
   If it returns one or more leases, present them via `{{ask}}`
   (UUID, state, provider UUID, creation time). Let the user pick.
3. **Fallback to saved manifests**:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/list-saved-manifests.cjs"
   ```
   Show lease UUID, image, size, and any `sku_uuid` / `provider_uuid` in
   the picker. Keep the choice keyed by `lease_uuid`; never infer missing SKU IDs
   from `size` on an older record.
4. **Last resort**: ask the user to paste a UUID. Validate against the
   UUID regex before continuing.

The Fred resource JSON contains `active[]` and `pending[]` arrays.
Each summary has `uuid`, `state`, `provider_uuid`, and `created_at`; it
does not contain image, size, service inventory, or custom domains. Show
the returned fields and use `uuid` as the picker value. Enrich from a
matching saved record only when available, labeling it as a local snapshot.
Do not invent missing values or interpret resource failure as an empty
account; use the saved-record/manual fallback. The resource is a bounded
snapshot, not a guarantee that every historical lease is listed.

Store the chosen UUID as `LEASE_UUID`.

## Step 2 — Fetch + render

Call `{{tool:fred/app_releases}}({ lease_uuid: LEASE_UUID })`.
Read `structuredContent` or parse the JSON text fallback. Check for MCP
`isError: true` / JSON `error: true` before rendering; a failed query must
not become an empty or healthy report. Create a private directory with
`mktemp -d` and capture its path as `RESPONSE_DIR`. Use **{{write_tool}}** to
create a new `response.json` inside it containing the successful payload as
JSON; do not create that file beforehand or use `mktemp -u`. The directory
is mode `0700`, so a host-created file at `0644` remains private inside it.
Never interpolate response values into a shell command, heredoc, or `echo`.
Bind `RESPONSE_DIR` and `RESPONSE_PATH` (the directory's `response.json`) to
shell-quoted paths in the same {{shell_tool}} call where they are used. Redirect
the file to the renderer's stdin:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/render-releases.cjs" < "$RESPONSE_PATH"
```

Remove `RESPONSE_PATH` and then the empty `RESPONSE_DIR` after rendering,
retaining the renderer's exit status. Also clean them up on cancellation or
{{write_tool}} failure. On renderer failure, report the diagnostic and stop.

**Print the script's stdout verbatim.** Do not paraphrase the table or
re-sort the rows; the script owns the canonical Markdown.

The server returns at most the 20 most recent releases. After the table,
show `release_count` and `truncated`; when truncated is true, explicitly
state that older releases were omitted. The renderer does not display
these fields. Surface any relevant release `reason` / `message` separately
as historical diagnostics, without treating an old failure as current
application state. Stored manifest bodies are omitted (`manifest_bytes`
reports only their size); this response cannot recover a previous spec.

## Step 3 — Note about rollback

After the table, append a single-line note:

> A rollback requires a separately retained manifest and an explicitly
> confirmed `update_app` operation. This history contains no recoverable
> manifest body; rollback is outside this skill.

This sets expectations: the table is informational, not a rollback UI.

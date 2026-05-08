---
description: >
  List registered providers on the active Manifest chain. Read-only.
  Defaults to active providers only; pass `--all` as the argument to
  include inactive entries. Foundational for SKU picking and
  provider-aware deploy flows.
allowed-tools: Bash(*), Read
---

# List Providers

You are listing the providers registered on the chain. Read-only — no
broadcasts, no state mutation.

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Fetching the
provider list", not "Now in Step 2 the MCP call".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart
Claude Code so the SessionStart hook runs, then stop.

This skill does not read `update-config.cjs --status` — `get_providers`
is a pure chain query that doesn't need agent state.

## Step 1 — Parse `$ARGUMENTS`

- If `$ARGUMENTS` is empty → `ACTIVE_ONLY = true` (default).
- If `$ARGUMENTS` is exactly `--all` → `ACTIVE_ONLY = false`.
- Anything else → reject with a usage hint:
  > Usage: `/manifest-agent:list-providers` (active only) or
  > `/manifest-agent:list-providers --all` (include inactive).
  Stop without making any MCP call.

## Step 2 — Fetch + render

Call:

```
mcp__manifest-lease__get_providers({ active_only: ACTIVE_ONLY })
```

Then pipe the JSON response through the renderer:

```bash
echo '<get_providers response>' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-providers.cjs"
```

**Print the script's stdout verbatim.** Do not paraphrase the table or
re-order the rows; the script owns the canonical Markdown.

## Step 3 — Optional follow-up

After the table, briefly note what the user can do with this:
> A specific provider's SKUs are queried via `get_skus` (filtered
> client-side by `providerUuid`); deploy-time provider selection is
> not yet wired into `/manifest-agent:deploy-app`.

Skip this note if the table was empty (`(no providers registered)`) —
nothing actionable to suggest in that case.

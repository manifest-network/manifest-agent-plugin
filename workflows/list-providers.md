---
name: list-providers
description: >
  List registered providers on the active Manifest chain. Read-only.
  Defaults to active providers only; pass `--all` as the argument to
  include inactive entries. Foundational for SKU picking and
  provider-aware deploy flows.
allowed-tools: Bash(*), Read, Write
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

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; {{environment_recovery}}.

This skill does not read `update-config.cjs --status` — `get_providers`
is a pure chain query that doesn't need agent state.

## Step 1 — Parse `{{arguments}}`

- If `{{arguments}}` is empty → `ACTIVE_ONLY = true` (default).
- If `{{arguments}}` is exactly `--all` → `ACTIVE_ONLY = false`.
- Anything else → reject with a usage hint:
  > Usage: `{{invoke:list-providers}}` (active only) or
  > `{{invoke:list-providers}} --all` (include inactive).
  Stop without making any MCP call.

## Step 2 — Fetch + render

Call:

```
{{tool:lease/get_providers}}({ active_only: ACTIVE_ONLY })
```

Read `structuredContent` or parse the JSON text fallback. Check for MCP
`isError: true` / JSON `error: true` before rendering; a failed query must
not become an empty or healthy report. Create a private file with `mktemp`,
capture its path as `RESPONSE_PATH`, and use **{{write_tool}}** to write the
successful payload as JSON. Never interpolate response values into a shell
command, heredoc, or `echo`. Bind the file path using shell quoting in the
same {{shell_tool}} call, then redirect it to the renderer's stdin:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/render-providers.cjs" < "$RESPONSE_PATH"
```

Remove `RESPONSE_PATH` after rendering, retaining the renderer's exit
status. On renderer failure, report the diagnostic and stop.

**Print the script's stdout verbatim.** Do not paraphrase the table or
re-order the rows; the script owns the canonical Markdown.

## Step 3 — Optional follow-up

After the table, briefly note what the user can do with this:
> A specific provider's SKUs are queried via `get_skus` (filtered
> client-side by `providerUuid`). `{{invoke:author-manifest}}` records
> the selected catalog entry's SKU UUID and provider UUID in the draft;
> `{{invoke:deploy-app}}` preserves those compute selectors.

Skip this note if the table was empty (`(no providers registered)`) —
nothing actionable to suggest in that case.

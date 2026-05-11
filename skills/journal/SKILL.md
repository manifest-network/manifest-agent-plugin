---
description: >
  Query the operation journal — the read-only audit trail of every
  state-changing skill invocation. Filter by date, skill, lease UUID,
  signer address, or outcome. User-invoked only — not for Claude to
  auto-discover.
allowed-tools: Bash(*)
disable-model-invocation: true
---

# Journal

Browse the append-only operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. Every state-changing
skill (deploy-app, manage-domain set/clear, init-agent, switch-chain,
set-gas-price, refresh-registry, import-key, author-manifest,
troubleshoot-deployment with close_lease) writes one record per
invocation: intent, plan summary, tool calls (args redacted), outcome,
errors, recovery actions, final state.

This skill is read-only. It does NOT mutate the journal.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only — the user just sees
the filter prompts and the rendered records.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart
Claude Code so the SessionStart hook runs, then stop.

## Step 1 — Pick a filter mode

Use `AskUserQuestion`:

- **Today's records** — everything from today (UTC).
- **Specific date** — pick a single `YYYY-MM-DD`.
- **Date range** — pick `--since` and `--until` (inclusive).
- **By skill** — filter to a single skill (e.g. `deploy-app`).
- **By lease UUID** — every record that mentions the UUID anywhere in
  the record tree (recursive walk: `final_state`, `tool_calls[].args_redacted`,
  `errors[]`, and any nested arrays — including positional args like
  `cosmos_estimate_fee.args[0]`).
- **By outcome** — `success` / `partial` / `failed` / `cancelled` / `journal_truncated`.
- **By signer address** — every record signed by a given `manifest1...`.
- **Recent failures (today)** — shorthand for "today's records where
  outcome != success".

Store the user's pick as `MODE`. For `MODE` values that need a follow-up
value (specific date, range, skill, lease UUID, outcome, signer), ask
for it after the mode pick:

- **Specific date** → ask for `DATE` (`YYYY-MM-DD`).
- **Date range** → ask for `SINCE` and `UNTIL` separately.
- **By skill** → ask for `SKILL_NAME` (offer common ones via
  `AskUserQuestion`: `deploy-app`, `manage-domain`, `init-agent`,
  `switch-chain`, `set-gas-price`, `refresh-registry`, `import-key`,
  `author-manifest`, `troubleshoot-deployment`).
- **By lease UUID** → ask for `LEASE_UUID`. Validate it loosely (8-4-4-4-12
  hex with dashes); the script enforces strict UUID-shape.
- **By outcome** → ask for `OUTCOME` via `AskUserQuestion` from the five
  options above.
- **By signer address** → ask for `SIGNER_ADDRESS`.

## Step 2 — Pick output format

Use `AskUserQuestion`:

- **Markdown (default)** — readable section blocks with bullet lists.
- **JSONL** — one record per line, raw JSON. Useful when piping to other
  tools.

Store as `FORMAT`.

## Step 3 — Query the journal

Compose the argv based on `MODE` and run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-read.cjs" \
  <flags built from MODE + follow-up values> \
  --format "<FORMAT>"
```

Argv recipes per `MODE`:

- **Today's records** → no date flags (default is today UTC).
- **Specific date** → `--date <DATE>`.
- **Date range** → `--since <SINCE> --until <UNTIL>`.
- **By skill** → `--skill <SKILL_NAME>` (no date flag — searches today
  by default; suggest the user combine with a date range if they want a
  longer window).
- **By lease UUID** → `--lease <LEASE_UUID>` (similarly, today by
  default; user can re-run with `--since`/`--until` for history).
- **By outcome** → `--outcome <OUTCOME>` (today by default).
- **By signer address** → `--signer <SIGNER_ADDRESS>` (today by
  default).
- **Recent failures** → start with `--outcome failed`. To cover all four
  non-success outcomes (`partial`, `failed`, `cancelled`,
  `journal_truncated`), run the script once per outcome and concatenate
  the results.

For "By skill" / "By lease UUID" / "By outcome" / "By signer address",
also offer the user a `--since`/`--until` range follow-up if they want
to widen the window beyond today. Default to today only.

## Step 4 — Surface the output

Print the script's stdout VERBATIM to the user. The script owns the
canonical Markdown / JSONL format; do not paraphrase.

If the output is `(no records match)` (markdown) or empty (jsonl), tell
the user "No records match those filters." Suggest they widen the date
range or relax filters.

## Notes

- The journal lives at `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`,
  one file per UTC day. Files are mode `0600`, parent dir `0700`. There
  is no automatic GC — the user manages disk by deleting old files
  manually.
- Records are redacted at write time: env values are reduced to keys
  only via `_journal.redactArgs`. The writer is fail-closed (NOT
  strip-and-continue): any key in the record tree matching
  `_journal.SECRET_KEY_DENYLIST` (`mnemonic`, `password`, `private_key`,
  `secret_key`, `api_key`, `auth_token`, `bearer_token` — all with
  optional `_`/`-` separators, case-insensitive) makes
  `journal-write.cjs` exit 1 and refuse to append.
- The journal is per-machine; if the user runs the plugin on multiple
  machines, that's two separate journals.
- A torn final line (e.g. from power loss mid-append) is silently
  dropped on read; well-formed records earlier in the same file are
  still surfaced.

---
name: refresh-registry
description: >
  Re-fetch chain registry data (RPC endpoints, gas prices, chain
  parameters) from the Cosmos chain registry. User-invoked only — not
  for Claude Code to auto-discover.
allowed-tools: Bash(*), Write
disable-model-invocation: true
---

<!-- Generated from workflows/refresh-registry.md by ci/build-packages.cjs. -->

# Refresh Chain Registry

Re-fetch the latest chain data from the Cosmos chain registry on GitHub.

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Fetching the latest
chain registry data", not "Now in Step 2 the registry fetch".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

## Step 1 — Capture pre-state (if config exists)

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it succeeds, capture `chains` from the output as `BEFORE` so Step 4 can
diff against post-state. Set `BEFORE = null` only when the diagnostic
explicitly says the config is missing. On unreadable/corrupt config or
other errors, report the diagnostic and stop for repair; never assume
that a failure means there is no identity to preserve.

## Step 2 — Fetch fresh data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Parse the JSON output: each present network key (`mainnet` / `testnet`)
identifies chain data successfully fetched and saved. A partial result exits
0 with a diagnostic; no successful networks emits `{}` and exits 1. Omitted keys
mean that network was not refreshed, and any older file remains. Preserve
stderr diagnostics. Invalid chain response shapes, chain IDs, RPC/REST
endpoints, or fee-token data fail validation before replacing the cached file;
report the named network and field from the diagnostic. Endpoints require
HTTPS, with HTTP allowed only for localhost; their schemes are saved lowercase
so the runtime uses HTTP transport. A listed fee token must have a valid
denomination and a finite nonnegative minimum gas price.
If neither network succeeded, report failure and
skip the config update. If only one succeeded, report the partial refresh;
do not claim both networks are current. Asset-list failures can also leave
denom labels as raw denoms. The fetch timestamp alone is not proof of
complete refresh.

## Step 3 — Update config (if it exists)

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --refresh-chains
```

If the command fails because config.json doesn't exist, that's fine — the
chain data files are still written to `$MANIFEST_PLUGIN_DATA/chains/` for future
use by `/manifest-agent:init-agent`.

If it succeeds, capture `chains` from the output as `AFTER`.
Other failures require reporting and repair; do not claim the config was
updated. If no valid active chain is selected, direct the user to
`/manifest-agent:switch-chain` to explicitly choose testnet or mainnet; repeating
`--refresh-chains` alone cannot select a chain, and mainnet still requires
that workflow's confirmation. For missing or malformed network metadata,
resolve the fetch diagnostic and verify the affected network was saved
before retrying the config merge. A malformed file for the other network
does not authorize switching the active chain.
Refresh only merges existing files; it never downloads missing metadata.
It replaces chain entries from the files currently present,
so after a partial fetch it can retain an older entry for the failed
network. It preserves explicit `gasPrice` and `gasMultiplier` overrides;
use `/manifest-agent:set-gas-price` to change those separately.

**IMPORTANT**: Do NOT read `$MANIFEST_PLUGIN_DATA/config.json` directly — it
may contain a legacy key password. Use the scripts above which never expose the
password.

## Step 4 — Report

Tell the user what was updated:
- When a config update succeeded, `BEFORE` is non-null, and it differs
  from `AFTER`, list the specific
  fields that changed (e.g. `chains.testnet.rpcUrl`,
  `chains.testnet.feeTokens[0].fixedMinGasPrice`).
- When all requested networks fetched successfully and `BEFORE` and
  `AFTER` are structurally equal, report that no config fields changed.
  Never call a failed or partial fetch "already up to date".
- When `BEFORE` is null (first-time fetch), report what was newly written
  without claiming anything changed.
- If config.json was updated, remind the user to restart MCP servers.

## Step 5 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records.

Build the redacted record as an object with this shape. The placeholders
describe values, not serialized JSON; use actual booleans, arrays and nulls
where indicated. Never substitute runtime values into shell source.

```text
{
  "skill": "refresh-registry",
  "active_chain": "<activeChain from Step 1 status, or null if no config>",
  "signer_address": "<address from Step 1 status, or null>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "refresh chain registry",
  "tool_calls": [],
  "outcome": "<success|partial|failed from actual fetch/config results>",
  "final_state": {
    "chains_changed": ["<list of dotted-path fields that changed, or empty array>"],
    "config_updated": "<true|false>"
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

Use `chains_changed: []` when there was no comparable config change.
Set `config_updated` to a boolean reflecting the actual config write,
and record concise failure diagnostics in `errors`. A partial network
refresh is `partial`; no successful fetch is `failed`. Do NOT mention a
successful journal write in your reply to the user.

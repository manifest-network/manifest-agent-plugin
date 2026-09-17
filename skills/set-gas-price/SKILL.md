---
name: set-gas-price
description: >
  Select the default gas fee token at its registry minimum price and/or
  change the gas multiplier used by the Manifest MCP servers. Shows tokens from the chain
  registry. Use when the user requests this operation.
allowed-tools: Bash(*), Write
disable-model-invocation: true
---

<!-- Generated from workflows/set-gas-price.md by ci/build-packages.cjs. -->

# Set Gas Price

Change the gas fee settings used by the Manifest agent's MCP servers.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Updating the gas
fee token to PWR", not "Now in Step 4 the config write".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If config is absent, tell the user to run `/manifest-agent:init-agent` first and stop.
If an existing config is unreadable or invalid, show the sanitized diagnostic
and stop; repair it privately or preserve a private backup before initialization.
Otherwise parse the JSON output. Show the user their current settings:
- Gas price (token and amount)
- Gas multiplier (if set, otherwise "default: 1.5")
- Active chain

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain the key password.

## Step 1 — What to change

Use AskUserQuestion to ask what the user wants to change:

- **Gas fee token** — switch between available tokens (e.g., MFX, PWR)
- **Gas multiplier** — adjust the gas simulation multiplier (default: 1.5, must be >= 1)
- **Both**

## Step 2 — Change gas fee token (if selected)

The Step 0 status output already includes the chain registry data under
`chains.<activeChain>.feeTokens`. Read the `feeTokens` array from that
field — each entry has `symbol`, `denom`, and `fixedMinGasPrice`. Do NOT
`cat` the chain file directly; the status output is the single safe-fields
source.

Use AskUserQuestion to ask which token to use, showing the **symbol** and
**min gas price** for each:

- **MFX** (min gas price: 1)
- **PWR** (min gas price: 0.37)

Store the user's choice as `GAS_TOKEN` (the symbol). The script handles
denom resolution and gas-price string composition; do NOT compose it
inline.

## Step 3 — Change gas multiplier (if selected)

Ask the user for the new gas multiplier value. Explain:
- Default is **1.5** (50% buffer over simulated gas)
- Must be **>= 1.0**
- Higher values = more likely to succeed but cost more
- **1.0** = exact simulated gas (may fail if estimate is tight)
- **2.0** = double the simulated gas (generous buffer)

## Step 4 — Apply changes

Pass whichever flags changed. If only the token changed:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-token 'GAS_TOKEN'
```

If only the multiplier changed:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-multiplier 1.8
```

Both at once:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-token 'GAS_TOKEN' --gas-multiplier 1.8
```

Replace `GAS_TOKEN` with the symbol the user chose in Step 2 (e.g., `MFX`)
as a properly shell-escaped literal, including any apostrophes. Registry
symbols are data, not shell code.
Passing no flags is a usage error.

If the update fails, stop and report its diagnostic; do not claim success or
write a success journal entry. A legacy credential migration can require an
unlocked credential store before the change succeeds. Parse successful JSON
output to confirm the update.

## Step 5 — Report

Tell the user:
1. The new gas settings
2. MCP servers need to be restarted to use the new settings

## Step 6 — Record this run in the journal

Append one record to the operation journal at
`$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. The writer auto-fills
`timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` —
omit them. Do NOT include any key matching the writer's secret denylist
— `_journal.SECRET_KEY_DENYLIST` (mnemonic, password, private_key,
secret_key, api_key, auth_token, bearer_token — case-insensitive,
optional `_`/`-` separators; canonical regex in `scripts/_journal.cjs`);
the writer is fail-closed and will exit 1 rather than append such
records.

Build the redacted record as an object with this shape. Placeholders describe
in-memory values; never substitute them into shell source or treat the sketch
as already serialized JSON.

```text
{
  "skill": "set-gas-price",
  "active_chain": "<activeChain from Step 0 status>",
  "signer_address": "<address from Step 0 status>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "<short structural summary, e.g. 'change gas_token MFX -> PWR'>",
  "tool_calls": [],
  "outcome": "success",
  "final_state": { "gas_token": "<symbol or null>", "gas_multiplier": "<number or null>" },
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

If the user cancelled mid-flow (e.g.
in Step 1), set `outcome` to `"cancelled"` and adjust `final_state`
accordingly. Do NOT mention the journal write in your reply to the user
— it's an internal audit trail.

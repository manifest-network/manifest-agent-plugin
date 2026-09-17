---
name: switch-chain
description: >
  Switch the Manifest agent's active chain between testnet and mainnet.
  Re-fetches the Cosmos chain registry data and updates config.json.
  Use when the user requests this operation.
allowed-tools: Bash(*), Write
disable-model-invocation: true
---

<!-- Generated from workflows/switch-chain.md by ci/build-packages.cjs. -->

# Switch Active Chain

You are switching the Manifest agent's active chain between testnet and mainnet.

**For all user choices in this skill, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Switching to mainnet
now", not "Now in Step 2 the broadcast confirmation".

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
and stop. It must be repaired privately or moved aside as a private backup;
it may still contain a recoverable legacy password. Otherwise parse the JSON
to get `activeChain` and `address`. Show the current active chain and address.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — legacy copies may contain the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 1 — Choose new chain

Use `AskUserQuestion` (do NOT prompt with free-form prose — the binary
choice should be a click, not a typed answer):

- **testnet** (`manifest-ledger-testnet`)
- **mainnet** (`manifest-ledger-mainnet`)

Store the answer as `CHOSEN_CHAIN`. If `CHOSEN_CHAIN === activeChain`,
tell the user "Already on `<chain>` — nothing to change" and stop.

## Step 2 — Confirm mainnet switch (if applicable)

If `CHOSEN_CHAIN === "mainnet"`, ask via `AskUserQuestion` BEFORE running
the registry fetch (warn before any side effect, even harmless ones):

> You are about to switch to mainnet. Transactions will use real funds.
> Continue?

Options: **Yes** / **No**. Stop on No.

## Step 3 — Re-fetch registry data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Check the exit status and parse the JSON output. Each present network key
identifies data successfully fetched and saved. Require `CHOSEN_CHAIN` in
that output before continuing. If the helper fails or that key is absent,
report the diagnostic and stop before updating config; an older cached file
is not proof of a fresh fetch. Report any partial refresh without claiming
both networks are current.

## Step 4 — Update config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --chain 'CHOSEN_CHAIN' --refresh-chains
```

Replace `CHOSEN_CHAIN` with `testnet` or `mainnet`.

If the update fails, stop and report its diagnostic; do not claim a switch or
write a success journal entry. A legacy credential migration can require an
unlocked credential store before the change succeeds. Parse successful JSON
output to confirm the chain was switched. The existing gas price is retained;
if it uses a factory denom, check that denom belongs to the new chain and offer
`/manifest-agent:set-gas-price` when it needs changing.

## Step 5 — Report

Tell the user:
1. Active chain is now `<new chain>`
2. Chain ID, RPC URL, REST URL, and explorer URL (from the JSON output)
3. MCP servers need to be restarted to connect to the new chain
4. Their agent address remains the same (same key works on both chains, but
   balances differ)

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
  "skill": "switch-chain",
  "active_chain": "<new active chain — testnet or mainnet>",
  "signer_address": "<address from Step 0>",
  "intent": "<a brief paraphrase of the user's request — what they want to accomplish, not their verbatim message; max ~240 chars; do NOT echo any secrets the user may have typed (passwords, API keys, mnemonics) — the value field is not redacted>",
  "plan_summary": "<old chain> -> <new chain>",
  "tool_calls": [],
  "outcome": "success",
  "final_state": { "active_chain": "<new chain>", "chain_id": "<chain ID from update-config output>" },
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

If the user cancelled (Step 1 "already on chain" early-out, or Step 2
mainnet decline), set `outcome` to `"cancelled"` and adjust
`final_state`. Do NOT mention the journal write in your reply to the
user — it's an internal audit trail.

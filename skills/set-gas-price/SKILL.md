---
description: >
  Change the default gas fee token, price, and/or gas multiplier used by
  the Manifest MCP servers. Shows available fee tokens from the chain
  registry. User-invoked only — not for Claude to auto-discover.
allowed-tools: Bash(*)
disable-model-invocation: true
---

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

If it fails, tell the user to run `/manifest-agent:init-agent` first and stop. Otherwise parse the JSON output. Show the user their current settings:
- Gas price (token and amount)
- Gas multiplier (if set, otherwise "default: 1.5")
- Active chain

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — it contains the key password.

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
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-token GAS_TOKEN
```

If only the multiplier changed:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-multiplier 1.8
```

Both at once:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-token GAS_TOKEN --gas-multiplier 1.8
```

Replace `GAS_TOKEN` with the symbol the user chose in Step 2 (e.g., `MFX`).
Passing no flags is a usage error.

Parse the JSON output to confirm the update.

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

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/journal-write.cjs" <<'JOURNAL_EOF'
{
  "skill": "set-gas-price",
  "active_chain": "<activeChain from Step 0 status>",
  "signer_address": "<address from Step 0 status>",
  "intent": "<the user's request, in their words, max ~240 chars>",
  "plan_summary": "<short structural summary, e.g. 'change gas_token MFX -> PWR'>",
  "tool_calls": [],
  "outcome": "success",
  "final_state": { "gas_token": "<symbol or null>", "gas_multiplier": "<number or null>" },
  "errors": [],
  "recovery_actions": []
}
JOURNAL_EOF
```

Substitute the bracketed values inline before running the heredoc; no
`<...>` placeholders should remain. If the user cancelled mid-flow (e.g.
in Step 1), set `outcome` to `"cancelled"` and adjust `final_state`
accordingly. Do NOT mention the journal write in your reply to the user
— it's an internal audit trail.

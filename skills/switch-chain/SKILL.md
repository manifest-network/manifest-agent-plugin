---
name: switch-chain
description: >
  Switch the Manifest agent's active chain between testnet and mainnet.
  Re-fetches the Cosmos chain registry data and updates config.json.
  User-invoked only — not for Claude to auto-discover.
allowed-tools: Bash(*)
disable-model-invocation: true
---

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

If it fails, tell the user to run `/manifest-agent:init-agent` first and stop. Otherwise parse the JSON to get `activeChain` and `address`. Show the user their current active chain and agent address.

**Never** read `$MANIFEST_PLUGIN_DATA/config.json` directly — it contains the key password. Always use `update-config.cjs --status` to read safe fields.

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

This refreshes both chains' data from the Cosmos chain registry.

## Step 4 — Update config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --chain CHOSEN_CHAIN --refresh-chains
```

Replace `CHOSEN_CHAIN` with `testnet` or `mainnet`.

Parse the JSON output to confirm the chain was switched.

## Step 5 — Report

Tell the user:
1. Active chain is now `<new chain>`
2. Chain ID, RPC URL, REST URL, and explorer URL (from the JSON output)
3. MCP servers need to be restarted to connect to the new chain
4. Their agent address remains the same (same key works on both chains, but
   balances differ)

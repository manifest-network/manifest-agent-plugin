---
name: switch-chain
description: >
  Switch the Manifest agent between testnet and mainnet. Re-fetches chain
  registry data and updates the active chain configuration.
allowed-tools: Bash(*), Read, Write
---

# Switch Active Chain

You are switching the Manifest agent's active chain between testnet and mainnet.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Read current status

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first.

Stop here.

Parse the JSON output to get `activeChain` and `address`. Show the user their
current active chain and agent address.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password. Always use `update-config.cjs --status` to read safe fields.

## Step 2 — Choose new chain

Ask the user which chain to switch to:

- **testnet** (`manifest-ledger-testnet`)
- **mainnet** (`manifest-ledger-mainnet`)

If they choose the same chain that's already active, confirm there's nothing to
change and stop.

## Step 3 — Re-fetch registry data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

This refreshes both chains' data from the Cosmos chain registry.

## Step 4 — Confirm mainnet switch

If the user chose **mainnet**, warn them before proceeding:
> You are about to switch to mainnet. Transactions will use real funds. Continue?

Wait for confirmation. If the user declines, stop.

## Step 5 — Update config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --chain CHOSEN_CHAIN --refresh-chains
```

Replace `CHOSEN_CHAIN` with `testnet` or `mainnet`.

Parse the JSON output to confirm the chain was switched.

## Step 6 — Report

Tell the user:
1. Active chain is now `<new chain>`
2. Chain ID, RPC URL, REST URL, and explorer URL (from the JSON output)
3. MCP servers need to be restarted to connect to the new chain
4. Their agent address remains the same (same key works on both chains, but
   balances differ)

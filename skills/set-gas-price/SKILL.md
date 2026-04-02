---
name: set-gas-price
description: >
  Change the default gas fee token, price, and/or gas multiplier used by the
  MCP servers. Shows available fee tokens from the chain registry.
allowed-tools: Bash(*), Read
---

# Set Gas Price

Change the gas fee settings used by the Manifest agent's MCP servers.

**For all user choices in this skill, use the AskUserQuestion tool to present
the options so the user can select from a list instead of typing.**

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Read current config

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If the command fails, tell the user:
> No agent configuration found. Run `/manifest-agent:init-agent` first.

Stop here.

Parse the JSON output. Show the user their current settings:
- Gas price (token and amount)
- Gas multiplier (if set, otherwise "default: 1.5")
- Active chain

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password.

## Step 2 — What to change

Use AskUserQuestion to ask what the user wants to change:

- **Gas fee token** — switch between available tokens (e.g., MFX, PWR)
- **Gas multiplier** — adjust the gas simulation multiplier (default: 1.5, must be >= 1)
- **Both**

## Step 3 — Change gas fee token (if selected)

Read the chain data file for the active chain:

```bash
cat ~/.manifest-agent/chains/ACTIVE_CHAIN.json
```

Replace `ACTIVE_CHAIN` with the `activeChain` value from Step 1.

Parse the `feeTokens` array. Each token has `symbol`, `denom`, and
`fixedMinGasPrice`.

Use AskUserQuestion to ask which token to use, showing the **symbol** and
**min gas price** for each:

- **MFX** (min gas price: 1)
- **PWR** (min gas price: 0.37)

Compose the gas price string from the selected token's `fixedMinGasPrice` and
`denom` (the raw on-chain denom, NOT the symbol) as `<fixedMinGasPrice><denom>`.

## Step 4 — Change gas multiplier (if selected)

Ask the user for the new gas multiplier value. Explain:
- Default is **1.5** (50% buffer over simulated gas)
- Must be **>= 1.0**
- Higher values = more likely to succeed but cost more
- **1.0** = exact simulated gas (may fail if estimate is tight)
- **2.0** = double the simulated gas (generous buffer)

## Step 5 — Apply changes

Build the update command with the appropriate flags:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-price GAS_PRICE --gas-multiplier GAS_MULTIPLIER
```

Include only the flags that changed. For example, if only the token changed:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-price 1umfx
```

If only the multiplier changed:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-multiplier 1.8
```

Parse the JSON output to confirm the update.

## Step 6 — Report

Tell the user:
1. The new gas settings
2. MCP servers need to be restarted to use the new settings

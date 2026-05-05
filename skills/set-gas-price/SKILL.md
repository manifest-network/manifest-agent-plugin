---
name: set-gas-price
description: >
  Change the default gas fee token, price, and/or gas multiplier used by the
  MCP servers. Shows available fee tokens from the chain registry.
allowed-tools: Bash(*), Read
---

# Set Gas Price

Change the gas fee settings used by the Manifest agent's MCP servers.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Step numbers are scaffolding for skill authors only. To the user, just
describe what you're doing in plain language — e.g. "Updating the gas
fee token to PWR", not "Now in Step 5 the config write".

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

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

The Step 1 status output already includes the chain registry data under
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

## Step 4 — Change gas multiplier (if selected)

Ask the user for the new gas multiplier value. Explain:
- Default is **1.5** (50% buffer over simulated gas)
- Must be **>= 1.0**
- Higher values = more likely to succeed but cost more
- **1.0** = exact simulated gas (may fail if estimate is tight)
- **2.0** = double the simulated gas (generous buffer)

## Step 5 — Apply changes

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

Replace `GAS_TOKEN` with the symbol the user chose in Step 3 (e.g., `MFX`).
Passing no flags is a usage error.

Parse the JSON output to confirm the update.

## Step 6 — Report

Tell the user:
1. The new gas settings
2. MCP servers need to be restarted to use the new settings

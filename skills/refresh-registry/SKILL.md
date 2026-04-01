---
name: refresh-registry
description: >
  Re-fetch chain registry data from the Cosmos chain registry. Use when
  RPC endpoints, gas prices, or other chain parameters may have changed.
allowed-tools: Bash(*), Read, Write
---

# Refresh Chain Registry

Re-fetch the latest chain data from the Cosmos chain registry on GitHub.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If the output is empty, tell the user to restart Claude Code and stop.

## Step 1 — Fetch fresh data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Parse the JSON output to see the updated chain data for both mainnet and testnet.

## Step 2 — Update config (if it exists)

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --refresh-chains
```

If the command fails because config.json doesn't exist, that's fine — the chain
data files are still written to `~/.manifest-agent/chains/` for future use by
`/manifest-agent:init-agent`.

If it succeeds, parse the JSON output to see the updated chains data.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it contains
the key password. Use the scripts above which never expose the password.

## Step 3 — Report

Tell the user what was updated:
- If anything changed, list the specific fields that differ (compare the output
  from Step 1 with the previous chain data shown in Step 2)
- If nothing changed, confirm that the chain data is already up to date
- If config.json was updated, remind the user to restart MCP servers

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

Check if `~/.manifest-agent/config.json` exists.

If it does, read the current config and read the fresh chain files from
`~/.manifest-agent/chains/mainnet.json` and `~/.manifest-agent/chains/testnet.json`.

Compare the old `chains` section with the new data. Note any differences
(changed RPC URLs, gas prices, explorer URLs, etc.).

Update the `chains` section in config.json with the fresh data. Write it back,
then:

```bash
chmod 600 ~/.manifest-agent/config.json
```

If config.json does not exist, that's fine — the chain data files are still
written to `~/.manifest-agent/chains/` for future use by `/manifest-agent:init-agent`.

## Step 3 — Report

Tell the user what was updated:
- If anything changed, list the specific fields that differ
- If nothing changed, confirm that the chain data is already up to date
- If config.json was updated, remind the user to restart MCP servers

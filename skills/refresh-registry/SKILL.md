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

If empty, `$MANIFEST_PLUGIN_ROOT` is not set; tell the user to restart Claude Code so the SessionStart hook runs, then stop.

## Step 1 — Capture pre-state (if config exists)

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status 2>/dev/null
```

If it succeeds, capture `chains` from the output as `BEFORE` so Step 4 can
diff against post-state. If it fails (no config yet), set `BEFORE = null`
and continue — first-time refreshes have nothing to compare against.

## Step 2 — Fetch fresh data

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/fetch-chain-registry.cjs"
```

Parse the JSON output to see the freshly-fetched chain data for mainnet
and testnet.

## Step 3 — Update config (if it exists)

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --refresh-chains
```

If the command fails because config.json doesn't exist, that's fine — the
chain data files are still written to `~/.manifest-agent/chains/` for future
use by `/manifest-agent:init-agent`.

If it succeeds, capture `chains` from the output as `AFTER`.

**IMPORTANT**: Do NOT read `~/.manifest-agent/config.json` directly — it
contains the key password. Use the scripts above which never expose the
password.

## Step 4 — Report

Tell the user what was updated:
- When `BEFORE` is non-null AND differs from `AFTER`, list the specific
  fields that changed (e.g. `chains.testnet.rpcUrl`,
  `chains.testnet.feeTokens[0].fixedMinGasPrice`).
- When `BEFORE === AFTER` or `AFTER` is unchanged structurally, confirm
  the chain data is already up to date.
- When `BEFORE` is null (first-time fetch), report what was newly written
  without claiming anything changed.
- If config.json was updated, remind the user to restart MCP servers.

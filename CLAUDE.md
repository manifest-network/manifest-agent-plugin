# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin (`manifest-agent`) that bootstraps an autonomous agent for the Manifest blockchain. It installs MCP tooling, manages keypairs, fetches chain registry data, and configures everything so the agent can interact with testnet or mainnet.

## Architecture

**Plugin root is read-only in production.** Marketplace installs copy the plugin to `~/.claude/plugins/cache/`. All mutable state lives in `~/.manifest-agent/`.

```
Plugin root (read-only)          Runtime data (~/.manifest-agent/)
├── scripts/*.cjs                ├── config.json        (0600, has key password)
├── skills/*/SKILL.md            ├── keys/agent-*.json  (0600, encrypted wallets)
├── hooks/hooks.json             ├── chains/{mainnet,testnet}.json
├── .mcp.json                    ├── node_modules/      (deps installed here)
└── package.json                 └── package.json       (copied from plugin root)
```

**Data flow**: Skills run scripts → scripts write to `~/.manifest-agent/` → MCP wrapper reads `config.json` at startup → spawns MCP binary with computed env vars.

**Dependency resolution**: All scripts are CJS (`.cjs`) because NODE_PATH only works with CommonJS, not ESM. Skills invoke scripts with `NODE_PATH=$HOME/.manifest-agent/node_modules` so `require()` finds packages installed outside the plugin root.

**Plugin root discovery**: A SessionStart hook exports `MANIFEST_PLUGIN_ROOT` via `CLAUDE_ENV_FILE`. Skills use `$MANIFEST_PLUGIN_ROOT` to locate scripts.

## Key Patterns

**All scripts use CJS** — `require()`, async IIFE with `.catch(() => process.exit(1))`, `os.homedir()` for paths (never literal `~` — Node doesn't expand it).

**Secrets via stdin** — Mnemonics are piped via heredoc (`<<'EOF'`, single-quoted to prevent shell expansion), never as command-line args (visible in `/proc/*/cmdline`).

**MCP wrapper** (`start-server.cjs`) — Reads `config.json`, builds env vars, spawns `~/.manifest-agent/node_modules/.bin/manifest-mcp-<name>` directly (not npx — 30ms vs 800ms startup). Forwards SIGTERM/SIGINT/SIGHUP. Uses `stdio: 'inherit'` so MCP JSON-RPC passes through transparently.

**Falsy env vars** — The wrapper omits optional env vars when falsy rather than setting them to `''`. Empty `MANIFEST_KEY_PASSWORD` causes the MCP server to throw.

## Skills

Invoked as `/manifest-agent:<skill-name>`. All skills guard that `$MANIFEST_PLUGIN_ROOT` is set (Step 0).

- **init-agent** — Full setup: install deps, fetch registry, choose chain, generate or import key, write config
- **import-key** — Import existing mnemonic (requires init-agent first)
- **switch-chain** — Switch testnet/mainnet with mainnet confirmation before write
- **refresh-registry** — Re-fetch chain data from Cosmos chain registry

## config.json → MCP env var mapping

`start-server.cjs` maps config fields to env vars for the MCP child process:

| Config path | Env var | Required |
|---|---|---|
| `chains[activeChain].chainId` | `COSMOS_CHAIN_ID` | yes |
| `chains[activeChain].rpcUrl` | `COSMOS_RPC_URL` | yes |
| `chains[activeChain].gasPrice` | `COSMOS_GAS_PRICE` | yes |
| `chains[activeChain].restUrl` | `COSMOS_REST_URL` | no (omit if falsy) |
| `agent.keyFile` | `MANIFEST_KEY_FILE` | no (omit if falsy) |
| `agent.keyPassword` | `MANIFEST_KEY_PASSWORD` | no (omit if falsy) |

## Testing Changes

```bash
# Test the plugin locally
claude --plugin-dir .

# Test fetch-chain-registry independently
node scripts/fetch-chain-registry.cjs

# Install deps (one-time, before testing key scripts or MCP wrapper)
mkdir -p ~/.manifest-agent && cp package.json ~/.manifest-agent/
npm install --production --prefix ~/.manifest-agent

# Test key generation
NODE_PATH=$HOME/.manifest-agent/node_modules node scripts/gen-agent-key.cjs --prefix manifest

# Test MCP wrapper (requires config.json + deps)
node scripts/start-server.cjs chain
```

## Chain Data

Fetched from the Cosmos chain registry (`cosmos/chain-registry` on GitHub):
- Mainnet: `manifest/chain.json` — chain ID `manifest-ledger-mainnet`, RPC at `nodes.liftedinit.app`
- Testnet: `testnets/manifesttestnet/chain.json` — chain ID `manifest-ledger-testnet`, RPC at `nodes.liftedinit.tech`
- Gas: both `umfx` and factory `upwr` token are valid fee tokens. The plugin extracts `fees.fee_tokens[0]` (umfx) by default.

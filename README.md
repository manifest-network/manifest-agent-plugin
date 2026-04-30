# manifest-agent

A [Claude Code](https://claude.ai/code) plugin that sets up [Manifest](https://manifestai.org/) blockchain MCP tooling for an autonomous agent.

It handles keypair generation and import, chain configuration (testnet/mainnet), live chain registry data from the [Cosmos chain registry](https://github.com/cosmos/chain-registry), and configuring four MCP servers (all bundled in [@manifest-network/manifest-mcp-node](https://www.npmjs.com/package/@manifest-network/manifest-mcp-node)) so the agent can interact with the configured chain.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI, desktop app, or IDE extension
- Node.js >= 18

## Installation

### For development

```bash
git clone https://github.com/liftedinit/manifest-agent-plugin.git
claude --plugin-dir ./manifest-agent-plugin
```

### From a marketplace

```bash
# Add a marketplace that includes this plugin, then:
# /plugin install manifest-agent@<marketplace-name>
```

## Quick Start

After installing the plugin, run:

```
/manifest-agent:init-agent
```

This walks you through:

1. Installing dependencies
2. Fetching chain data from the Cosmos chain registry
3. Choosing **testnet** or **mainnet**
4. Generating a new keypair or importing an existing mnemonic
5. Writing the agent configuration

After setup, restart Claude Code (or run `/mcp` and reconnect) to start the MCP servers.

### Deploying an app

Once initialized and funded, deploy a containerized app with:

```
/manifest-agent:deploy-app
```

This assumes you already have a public container image (e.g. `ghcr.io/me/app@sha256:…`) on a registry the Fred provider permits. The plugin walks you through SKU selection, manifest authoring (`/manifest-agent:author-manifest`), validation, a confirmation step showing the deployment plan, and live progress until your app is reachable. Failed deploys hand off to `/manifest-agent:troubleshoot-deployment` and offer to reclaim the lease.

Image build and image push are intentionally out of scope — bring your own published image.

## Skills

| Skill | Description |
|---|---|
| `/manifest-agent:init-agent` | Full interactive setup — install deps, choose chain, generate or import key |
| `/manifest-agent:import-key` | Import an existing mnemonic phrase into the agent config |
| `/manifest-agent:switch-chain` | Switch between testnet and mainnet |
| `/manifest-agent:set-gas-price` | Change the gas fee token, price, and/or gas multiplier |
| `/manifest-agent:refresh-registry` | Re-fetch chain data from the Cosmos chain registry |
| `/manifest-agent:deploy-app` | Deploy a containerized app end-to-end (assumes the image is already built and pushed). Pre-flight, manifest authoring, deployment plan, broadcast, ready polling, URL output |
| `/manifest-agent:author-manifest` | Build and validate a Fred container manifest interactively. Outputs a `MANIFEST_PREVIEW` block ready for `/manifest-agent:deploy-app` or direct `mcp__manifest-fred__deploy_app` |
| `/manifest-agent:troubleshoot-deployment` | Bundle status, diagnostics, and recent logs for a deployed lease into a unified report |

## MCP Servers

Once configured, the plugin provides four MCP servers, all launched from binaries bundled in `@manifest-network/manifest-mcp-node`:

| Server | Description |
|---|---|
| `manifest-chain` | Chain queries, bank send, testnet faucet |
| `manifest-lease` | Compute leasing |
| `manifest-fred` | Token factory |
| `manifest-cosmwasm` | MFX ↔ PWR conversion via CosmWasm |

The servers start automatically when Claude Code launches but **will fail until the plugin is initialized**. This is expected — run `/manifest-agent:init-agent` to set up the agent, then restart Claude Code to connect the servers.

### Troubleshooting

**MCP servers show "failed":**

- **Before init-agent**: Expected. The servers need `~/.manifest-agent/config.json` which doesn't exist yet. Run `/manifest-agent:init-agent` first, then restart.
- **After init-agent**: Check your Node.js version. The MCP servers require **Node.js 18+**. If your system default `node` is older, the wrapper exits with a `Node 18+ required (found vX.X.X)` error visible in the MCP server logs. Verify with `node --version` and update if needed. If you use nvm, run `nvm alias default 22` to set the default.

## Supported Chains

| Chain | Chain ID | RPC |
|---|---|---|
| Mainnet | `manifest-ledger-mainnet` | `https://nodes.liftedinit.app/manifest/rpc` |
| Testnet | `manifest-ledger-testnet` | `https://nodes.liftedinit.tech/manifest/testnet/rpc` |

Chain data (endpoints, gas prices, explorer URLs) is fetched live from the [Cosmos chain registry](https://github.com/cosmos/chain-registry) and can be refreshed at any time with `/manifest-agent:refresh-registry`.

## How It Works

```
┌──────────────────────┐     ┌──────────────────────────────┐
│  Plugin (read-only)  │     │  ~/.manifest-agent/ (mutable) │
│                      │     │                              │
│  scripts/*.cjs       │────>│  config.json   (agent config)│
│  skills/*/SKILL.md   │     │  keys/*.json   (encrypted)   │
│  hooks/hooks.json    │     │  chains/*.json (registry)    │
│  .mcp.json           │     │  node_modules/ (dependencies)│
└──────────────────────┘     └──────────────┬───────────────┘
                                            │
                              start-server.cjs reads config
                                            │
                                            v
                             ┌──────────────────────────┐
                             │  MCP Servers (stdio)     │
                             │  manifest-mcp-chain      │
                             │  manifest-mcp-lease      │
                             │  manifest-mcp-fred       │
                             │  manifest-mcp-cosmwasm   │
                             └──────────────────────────┘
```

- **Plugin root is read-only** in production (marketplace cache). All mutable state lives in `~/.manifest-agent/`.
- **Dependencies** (`@cosmjs/proto-signing`, `@manifest-network/manifest-mcp-node`) are installed to `~/.manifest-agent/node_modules/` during `init-agent`, not in the plugin directory.
- **MCP servers** are launched by a wrapper script (`start-server.cjs`) that reads `config.json` and passes the appropriate environment variables to the server binary.
- **Keypairs** are encrypted with a random 256-bit password and stored with `0600` permissions.

## Security

- Keyfiles are encrypted using CosmJS wallet serialization (Argon2id + XChaCha20-Poly1305) with a random 32-byte password
- Keyfiles are written with `0600` permissions; the keys directory with `0700`
- `config.json` is written with `0600` permissions (contains the key password)
- Mnemonics are imported from a user-created file via pipe — they never enter Claude's conversation context
- The key password flows between scripts via pipe and never enters the conversation
- The plugin root is never written to
- **Every broadcast transaction is double-confirmed.** A `SessionStart` hook injects a runtime policy telling the agent it must call `cosmos_estimate_fee` (or otherwise show an action + balance summary) and get your textual confirmation before broadcasting. A `PreToolUse` hook on every write tool then forces Claude Code to show its own permission prompt regardless of your pre-existing permission settings — a hard safety net on top of the agent's textual confirmation.

**Known trade-offs:**
- The key password is stored in plaintext in `config.json` (protected by file permissions). A future version may use the OS keychain.
- **Bypass permissions mode is lost after the first broadcast.** If you launch Claude Code with `--dangerously-skip-permissions` (or its interactive equivalent), the first transaction's permission prompt — which the plugin forces via a `PreToolUse` hook returning `"ask"` — will correctly prompt you, but due to upstream bug [anthropics/claude-code#37420](https://github.com/anthropics/claude-code/issues/37420), Claude Code will permanently reset bypass mode for the rest of the session. Every subsequent tool call (even unrelated reads) will require manual approval until you restart the session. For this plugin's use case — broadcasting real transactions — we consider this an acceptable degradation: anyone skipping permissions while spending real funds is already in a risky posture, and falling back to interactive mode after the first broadcast is arguably safer than the alternative. If the bug is fixed upstream we will reassess.

## License

MIT

## Author

[The Lifted Initiative](https://liftedinit.org)

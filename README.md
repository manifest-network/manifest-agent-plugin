# manifest-agent

A [Claude Code](https://claude.ai/code) plugin that sets up [Manifest](https://manifestai.org/) blockchain MCP tooling for an autonomous agent.

It handles keypair generation and import, chain configuration (testnet/mainnet), live chain registry data from the [Cosmos chain registry](https://github.com/cosmos/chain-registry), and configuring four MCP servers (all bundled in [@manifest-network/manifest-mcp-node](https://www.npmjs.com/package/@manifest-network/manifest-mcp-node)) so the agent can interact with the configured chain.

---

**Table of contents**

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Deploying an app](#deploying-an-app)
- [Custom domains](#custom-domains)
- [Operations](#operations)
- [Skills reference](#skills-reference)
- [MCP servers](#mcp-servers)
- [Troubleshooting](#troubleshooting)
- [Supported chains](#supported-chains)
- [How it works](#how-it-works)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI, desktop app, or IDE extension
- Node.js >= 18

## Installation

### From a marketplace

```bash
# Add a marketplace that includes this plugin, then:
# /plugin install manifest-agent@<marketplace-name>
```

### For development

```bash
git clone https://github.com/liftedinit/manifest-agent-plugin.git
claude --plugin-dir ./manifest-agent-plugin
```

After installing, the four MCP servers will appear in `/mcp` but **all four will fail until you initialize**. That's expected — they need a `config.json` that doesn't exist yet. Run `/manifest-agent:init-agent` first.

## Quick Start

### 1. Initialize the agent

```
/manifest-agent:init-agent
```

This walks you through:

1. Installing dependencies (the SessionStart hook does this automatically on first session, so it's usually a no-op)
2. Fetching chain data from the Cosmos chain registry
3. Choosing **testnet** or **mainnet**
4. Generating a new keypair, or importing an existing mnemonic
5. Writing the agent configuration

After setup, **restart Claude Code** (or run `/mcp` and reconnect) so the four MCP servers can pick up the new config.

### 2. Verify your setup

Once the MCP servers are connected, verify the agent is wired up correctly:

- **Wallet address & balance** — ask the agent: *"What's my wallet address and balance?"* It will use `mcp__manifest-chain__cosmos_query` (`module: bank, subcommand: balances`).
- **Active chain** — the agent can read `$MANIFEST_PLUGIN_DATA/config.json`'s `activeChain` field. You can also infer it from the `mcp__manifest-chain__cosmos_query` results.
- **Saved deployments** — `$MANIFEST_PLUGIN_DATA/manifests/` lists one JSON wrapper per past deployment (named `<lease_uuid>.json`). The `troubleshoot-deployment` skill includes a saved-manifest picker.

`$MANIFEST_PLUGIN_DATA` resolves to `~/.claude/plugins/data/<plugin-id>/` and is exposed to scripts as `$MANIFEST_PLUGIN_DATA`. It's where all your runtime state lives — config, keys, chain data, saved deployments. The plugin root is read-only; nothing is written to your clone or marketplace cache.

### 3. Fund your wallet

**Testnet** — request tokens from the testnet faucet via the agent:

> "Use the testnet faucet to fund my wallet."

The agent will call `mcp__manifest-chain__request_faucet` (intentionally not gated by the broadcast permission prompt — testnet tokens have no value).

**Mainnet** — fund your wallet's address externally (exchange, bridge, or transfer from another wallet). The agent has no built-in funding mechanism for mainnet.

## Deploying an app

Once your wallet is funded, you can deploy a containerized app three ways. All three assume you already have a public container image (e.g. `ghcr.io/me/app@sha256:…`) on a registry the Fred provider permits. Image build and image push are intentionally out of scope — bring your own published image.

### Image fast-path (single-service shortcut)

```
/manifest-agent:deploy-app docker.io/library/nginx:1.27
/manifest-agent:deploy-app ghcr.io/me/app@sha256:abc123…
```

If you pass an image reference (anything matching `<name>:<tag>` or `<name>@sha256:<digest>`), the plugin treats it as a single-service deploy and asks you only for what's still needed: SKU, port, and any optional env / labels / health check / etc. Skips the "what shape?" and "what image?" questions entirely.

### Multi-image stack fast-path

```
/manifest-agent:deploy-app docker.io/lifted/wordpress:6 docker.io/library/mysql:9
/manifest-agent:deploy-app wordpress:6 + mysql:9         # `+` is optional cosmetic separator
```

If you pass two or more image references separated by whitespace (with optional `+` tokens), the plugin treats them as services in a stack. Service names are derived from the image basenames (`wordpress`, `mysql`). The plugin shows you the parsed stack and asks for confirmation before authoring; you can rename services if the auto-derived names don't fit. Same per-service auto-detection as the single-service fast-path (ports, tmpfs, image defaults).

Inter-service env vars (e.g. `WORDPRESS_DB_HOST=mysql`, `WORDPRESS_DB_PASSWORD=...`) are NOT auto-wired — you provide them through the per-service env prompts. The intent-recap step before broadcast flags obvious gaps (e.g. a wordpress with no DB credentials).

### Sensitive env values (file-pipe pattern)

For secrets like database passwords, the env prompt offers a "From a file" option. Create a dotenv file in a separate terminal first:

```bash
cat > /tmp/wordpress.env
WORDPRESS_DB_HOST=mysql
WORDPRESS_DB_PASSWORD=hunter2
^D
chmod 600 /tmp/wordpress.env
```

Then tell the agent the path. Values flow through a script pipe into the spec file; they never enter the chat input box and the agent never echoes them in summaries. Mirrors the mnemonic-import pattern from `init-agent` / `import-key`.

Note: env values still appear in the `deploy_app` MCP tool call args at broadcast time — eliminating that exposure entirely needs upstream MCP changes.

### Interactive (full authoring, supports multi-service)

```
/manifest-agent:deploy-app
```

Walks you through choosing single-service vs multi-service stack, picking a SKU, entering image refs, ports, env vars, etc., then deploys. No reusable spec file is written in this path, but after a successful deploy a saved manifest record is created at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json`.

### From a spec file (reusable)

```
/manifest-agent:author-manifest        # walks you through, saves a spec file
/manifest-agent:deploy-app /path/to/the/saved-spec.json
```

The spec file is plain JSON — hand-edit it, version-control it, generate it from a script, share it across deploys. Default save location is `$MANIFEST_PLUGIN_DATA/manifests-drafts/`; a custom absolute path is allowed as long as it resolves inside that drafts directory or the system tmpdir.

#### Spec file shape

The spec is the same JSON shape `mcp__manifest-fred__build_manifest_preview` and `mcp__manifest-fred__deploy_app` accept:

```jsonc
// Single-service
{
  "image": "docker.io/library/nginx:1.27",
  "port": 80,
  "env": { "FOO": "bar" },               // optional
  "labels": { "app": "demo" },           // optional
  "command": ["/bin/sh"],                // optional
  "args": ["-c", "..."],                 // optional
  "health_check": { /* … */ },           // optional
  "storage": { /* … */ },                // optional
  "tmpfs": { /* … */ },                  // optional
  "init": false,                         // optional
  "customDomain": "app.example.com"      // optional, see below
}

// Multi-service stack
{
  "services": {
    "wordpress": { "image": "...", "ports": [80], "env": { /* … */ } },
    "mysql":     { "image": "...", "ports": [3306], "env": { /* … */ } }
  },
  "storage": { /* … */ },                // optional
  "depends_on": { /* … */ },             // optional
  "customDomain": "app.example.com",     // optional
  "serviceName": "wordpress"             // required when customDomain set on a stack
}
```

Authoritative validation lives in the Fred manifest JSON Schema bundled in `manifest-mcp-fred`. `build_manifest_preview` validates against it before any broadcast, so a malformed spec fails before spending gas.

### What happens before broadcast

A confirmation step shows the deployment plan (image, SKU, cost, wallet/credit balances) before any broadcast:

1. **Intent recap** — chain, signer address, format (single or stack), service count, env keys (never values).
2. **Readiness check** — `check_deployment_readiness` runs and any blocker is surfaced verbatim.
3. **DeploymentPlan block** — fees line-by-line (estimated via `cosmos_estimate_fee`), wallet balance, total cost.
4. **Permission prompt** — Claude Code's own prompt (the plugin forces this via a `PreToolUse` hook regardless of your permission settings).
5. **Broadcast** — `deploy_app` is called; on success you see a "Deployed." block with the URL.

Failed deploys auto-invoke a troubleshoot sequence and offer to reclaim the lease.

## Custom domains

Attach an FQDN to a lease item so users reach the app via your own hostname instead of the provider-assigned subdomain. Available at deploy time (set via `customDomain` in the spec or in any of the interactive flows) and standalone via `/manifest-agent:manage-domain` after the lease exists.

```
/manifest-agent:manage-domain    # interactive: set / clear / lookup
```

`manage-domain` runs a warn-only DNS pre-check before broadcasting — it queries A/AAAA/CNAME records for the FQDN with a 5-second timeout and surfaces the result, but does not block the broadcast. The chain is the authoritative arbiter of FQDN format and reservation; DNS resolution affects only browser routing, not the chain claim.

When `customDomain` is set on a deploy, `deploy_app` broadcasts TWO billing transactions atomically: `create-lease` AND `set-item-custom-domain`. The DeploymentPlan shows both fees line-by-line plus a `Total fee:` so you see the full cost before approving. The single permission prompt that fires next covers both transactions.

### DNS setup happens AFTER the deploy

You can't point your CNAME until you know the provider's ingress hostname, which is only assigned once `deploy_app` succeeds. The flow:

1. Deploy with `customDomain` set in the spec.
2. Note the provider FQDN from the success block.
3. Set your CNAME (or A record for an apex) at the provider FQDN.
4. Wait for DNS to propagate.
5. TLS is provisioned by the provider after the lease item picks up the domain — typically a few minutes after both the chain claim and DNS are in place.

### Partial-success failure

The upstream `deploy_app` runs `create-lease` → `set-item-custom-domain` → manifest upload → readiness poll. If anything after `create-lease` fails (most commonly the FQDN is already claimed by another tenant — the upstream `Deploy partially succeeded:` error), the lease was created on-chain but the manifest was NEVER uploaded, so no app is running yet.

The orchestrator detects this case, queries the lease state, and offers state-aware recovery:

- **Retry set-domain + upload** — re-attach the domain then upload the manifest via `update_app`.
- **Salvage without domain** — skip the domain; upload the manifest now so the lease starts serving.
- **Cancel/Close the lease** — uses `billing cancel-lease` (via `mcp__manifest-chain__cosmos_tx`) for `LEASE_STATE_PENDING`, and the `mcp__manifest-lease__close_lease` MCP tool for `LEASE_STATE_ACTIVE`.

## Operations

### Switching chain

```
/manifest-agent:switch-chain
```

Switches between testnet and mainnet. Mainnet selection requires explicit confirmation (the agent shows the chain ID and the wallet address before writing the change). After switching, restart Claude Code so the MCP servers reconnect with the new config.

### Updating gas price or multiplier

```
/manifest-agent:set-gas-price
```

Lets you change:

- **Gas fee token** — `umfx` (default) or factory `upwr`. Both are valid fee tokens on Manifest.
- **Gas price** — the per-unit price (e.g. `0.001`).
- **Gas multiplier** — applied to the simulated gas to produce the broadcast `gasLimit` (default `1.5`). Bump this if you frequently see out-of-gas errors.

### Refreshing chain registry data

```
/manifest-agent:refresh-registry
```

Re-fetches `manifest/chain.json` (mainnet) and `testnets/manifesttestnet/chain.json` (testnet) from the [Cosmos chain registry](https://github.com/cosmos/chain-registry). Run this when:

- An RPC endpoint goes stale and the registry has been updated.
- The default gas-fee-token list changes.
- You're debugging chain connection issues and want a clean slate.

This does NOT update the bundled Fred manifest schema (that's pinned in `manifest-mcp-fred` and changes only when `manifest-mcp-node` is bumped).

### Inspecting a deployment

```
/manifest-agent:troubleshoot-deployment
```

Bundles `app_status`, `app_diagnostics`, and recent `get_logs` for a deployed lease into one report. The lease picker offers three options: enter a UUID, pick from saved manifests, or look up by custom domain. Offers `close_lease` cleanup at the end if you want to reclaim the lease.

### Listing your saved deployments

There's no dedicated "list" command, but the saved manifests live at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` (one file per past deploy). The `troubleshoot-deployment` skill's lease picker enumerates them with redacted summaries (env keys, never values). You can also list them yourself:

```bash
ls ~/.claude/plugins/data/manifest-agent*/manifests/
```

The wrappers persist after a lease expires or is closed — they're a historical record, not a live state cache.

### Updating the plugin

Marketplace installs auto-update when Claude Code refreshes the marketplace (typically on session start). Your `$MANIFEST_PLUGIN_DATA` directory survives plugin updates, so config, keys, and saved deployments are preserved. The SessionStart hook diff-checks `package.json` between the new plugin root and your data dir and runs `npm install --omit=dev` automatically when they differ.

For development installs (`claude --plugin-dir`), pull the latest commits in your clone and restart Claude Code.

### Uninstalling

`/plugin uninstall manifest-agent` (or the equivalent UI action) removes the plugin and its data directory, including your config and keyfiles. **Back up `$MANIFEST_PLUGIN_DATA/keys/` before uninstalling** if you want to preserve the wallet — without the keyfile + the password from `config.json`, the wallet is unrecoverable from the plugin alone (you'd need the original mnemonic).

## Skills reference

| Skill | Description |
|---|---|
| `/manifest-agent:init-agent` | Full interactive setup — install deps, choose chain, generate or import key |
| `/manifest-agent:import-key` | Import an existing mnemonic phrase into the agent config |
| `/manifest-agent:switch-chain` | Switch between testnet and mainnet |
| `/manifest-agent:set-gas-price` | Change the gas fee token, price, and/or gas multiplier |
| `/manifest-agent:refresh-registry` | Re-fetch chain data from the Cosmos chain registry |
| `/manifest-agent:deploy-app [path-or-images]` | Deploy a containerized app end-to-end. Optional argument: a JSON spec file path, OR a single image reference (e.g. `nginx:1.27`) for a single-service fast-path, OR multiple whitespace-separated image references (e.g. `wordpress:6 mysql:9`) for a multi-service stack fast-path. Omit for full interactive authoring. Pre-flight → plan → confirm → broadcast → URL. Optional `customDomain` in the spec triggers a dual-tx broadcast (create-lease + set-item-custom-domain) with line-by-line fees in the plan |
| `/manifest-agent:author-manifest` | Build and validate a Fred deployment spec interactively (single-service or multi-service stack). Saves a JSON spec file (default location `$MANIFEST_PLUGIN_DATA/manifests-drafts/`) ready to feed to `/manifest-agent:deploy-app`. Optionally collects a custom domain (FQDN + service for stacks) |
| `/manifest-agent:manage-domain` | Set, clear, or look up the custom domain (FQDN) on an existing lease item. Set/clear go through cosmos_estimate_fee + textual confirm + permission prompt + on-chain verification; lookup is read-only |
| `/manifest-agent:troubleshoot-deployment` | Bundle status, diagnostics, and recent logs for a deployed lease into a unified report. Lease picker includes a "lookup by custom domain" option |
| `/manifest-agent:journal` | Read-only audit-trail query. Filter by date / skill / lease UUID / outcome / signer. Markdown or JSONL output. Records are written by every state-changing skill at the end of each invocation |

## MCP servers

Once configured, the plugin provides four MCP servers, all launched from binaries bundled in `@manifest-network/manifest-mcp-node`:

| Server | Description |
|---|---|
| `manifest-chain` | Chain queries, bank send, testnet faucet |
| `manifest-lease` | Compute leasing, custom domains |
| `manifest-fred` | Deploy / restart / update apps |
| `manifest-cosmwasm` | MFX ↔ PWR conversion via CosmWasm |

The servers start automatically when Claude Code launches but **will fail until the plugin is initialized**. This is expected — run `/manifest-agent:init-agent` to set up the agent, then restart Claude Code to connect the servers.

## Troubleshooting

### MCP servers show "failed"

**Before init-agent**: Expected. The servers need `$MANIFEST_PLUGIN_DATA/config.json` (which holds the chain choice + key password — created by init-agent, never created automatically). Run `/manifest-agent:init-agent` first, then restart. Dependencies (`node_modules/`) are installed automatically by the SessionStart hook on first run; if init-agent reports the binary is still missing, check `$MANIFEST_PLUGIN_DATA/.last-install.log` for an npm install failure.

**After init-agent**: Check your Node.js version. The MCP servers require **Node.js 18+**. If your system default `node` is older, the wrapper exits with a `Node 18+ required (found vX.X.X)` error visible in the MCP server logs. Verify with `node --version` and update if needed. If you use nvm, run `nvm alias default 22` to set the default.

### "Out of gas" during a broadcast

The plugin auto-retries once with `gas_multiplier` bumped by `0.1`. If the retry also fails, the agent reports both failures and stops. Persistent OOG errors usually mean the gas multiplier in your config is too low; bump it via `/manifest-agent:set-gas-price` (the multiplier defaults to `1.5`; try `2.0` if you're hitting OOG repeatedly).

### "Deploy partially succeeded:" error

A deploy with a custom domain failed after the lease was created but before the manifest was uploaded. See [Custom domains → Partial-success failure](#partial-success-failure) — the orchestrator handles this automatically and offers state-aware recovery.

### "FQDN already claimed by another tenant"

The custom domain you specified is already attached to another lease on-chain. Choose a different FQDN, or contact the current claimant. Use `/manifest-agent:manage-domain` with the lookup option to see which lease holds it.

### Permission prompts keep firing for read tools

Bypass permissions mode (`--dangerously-skip-permissions`) is permanently reset after the first broadcast prompt due to upstream Claude Code bug [#37420](https://github.com/anthropics/claude-code/issues/37420). This is a known trade-off — see [Security](#security) below.

### Lost the keyfile or forgot the password

The keyfile is encrypted with a password stored in `config.json` (protected by `0600` file permissions). If `config.json` is intact and you can read it, the password is in `agent.keyPassword`. If `config.json` is gone, the wallet is unrecoverable from the plugin — you'll need to re-import from your original mnemonic via `/manifest-agent:import-key`.

## Supported chains

| Chain | Chain ID | RPC |
|---|---|---|
| Mainnet | `manifest-ledger-mainnet` | `https://nodes.liftedinit.app/manifest/rpc` |
| Testnet | `manifest-ledger-testnet` | `https://nodes.liftedinit.tech/manifest/testnet/rpc` |

Chain data (endpoints, gas prices, explorer URLs) is fetched live from the [Cosmos chain registry](https://github.com/cosmos/chain-registry) and can be refreshed at any time with `/manifest-agent:refresh-registry`.

## How it works

```
┌──────────────────────┐     ┌─────────────────────────────────────┐
│  Plugin (read-only)  │     │  $MANIFEST_PLUGIN_DATA (mutable)    │
│                      │     │  ~/.claude/plugins/data/<id>/       │
│  scripts/*.cjs       │────>│  config.json   (agent config)       │
│  skills/*/SKILL.md   │     │  keys/*.json   (encrypted)          │
│  hooks/hooks.json    │     │  chains/*.json (registry)           │
│  .mcp.json           │     │  node_modules/ (dependencies)       │
└──────────────────────┘     └──────────────┬──────────────────────┘
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

- **Plugin root is read-only** in production (marketplace cache). All mutable state lives in `$MANIFEST_PLUGIN_DATA` — Claude Code's per-plugin persistent data directory at `~/.claude/plugins/data/<id>/`. The directory survives plugin updates and is cleaned on uninstall.
- **Dependencies** (`@cosmjs/proto-signing`, `@manifest-network/manifest-mcp-node`, `request-filtering-agent`) are installed to `$MANIFEST_PLUGIN_DATA/node_modules/` automatically by the SessionStart hook (diff-checked against the plugin's bundled `package.json` on every session start), not in the plugin directory.
- **MCP servers** are launched by a wrapper script (`start-server.cjs`) that reads `config.json` and passes the appropriate environment variables to the server binary.
- **Keypairs** are encrypted with a random 256-bit password and stored with `0600` permissions.

For the full architectural picture (data flow, scripts inventory, hook contracts), see [`CLAUDE.md`](CLAUDE.md).

## Security

- Keyfiles are encrypted using CosmJS wallet serialization (Argon2id + XChaCha20-Poly1305) with a random 32-byte password
- Keyfiles are written with `0600` permissions; the keys directory with `0700`
- `config.json` is written with `0600` permissions (contains the key password)
- Mnemonics are imported from a user-created file via pipe — they never enter Claude's conversation context
- The key password flows between scripts via pipe and never enters the conversation
- The plugin root is never written to
- **Every broadcast transaction is double-confirmed.** A `SessionStart` hook injects a runtime policy telling the agent it must call `cosmos_estimate_fee` (or otherwise show an action + balance summary) and get your textual confirmation before broadcasting. A `PreToolUse` hook on every write tool then forces Claude Code to show its own permission prompt regardless of your pre-existing permission settings — a hard safety net on top of the agent's textual confirmation.

### Known trade-offs

- The key password is stored in plaintext in `config.json` (protected by file permissions). A future version may use the OS keychain.
- **Bypass permissions mode is lost after the first broadcast.** If you launch Claude Code with `--dangerously-skip-permissions` (or its interactive equivalent), the first transaction's permission prompt — which the plugin forces via a `PreToolUse` hook returning `"ask"` — will correctly prompt you, but due to upstream bug [anthropics/claude-code#37420](https://github.com/anthropics/claude-code/issues/37420), Claude Code will permanently reset bypass mode for the rest of the session. Every subsequent tool call (even unrelated reads) will require manual approval until you restart the session. For this plugin's use case — broadcasting real transactions — we consider this an acceptable degradation: anyone skipping permissions while spending real funds is already in a risky posture, and falling back to interactive mode after the first broadcast is arguably safer than the alternative. If the bug is fixed upstream we will reassess.
- Env values supplied via the file-pipe pattern stay out of chat input and prose summaries, but they DO enter the agent's API context as part of the `build_manifest_preview` and `deploy_app` MCP tool call args at validation/broadcast time. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch naming, commit conventions, and the PR checklist. For testing, see [`docs/testing.md`](docs/testing.md). For the release flow, see [`docs/release.md`](docs/release.md). The architectural overview is in [`CLAUDE.md`](CLAUDE.md).

## License

MIT

## Author

[The Lifted Initiative](https://liftedinit.org)

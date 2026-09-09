# manifest-agent

A [Claude Code](https://claude.ai/code) plugin that sets up [Manifest](https://manifestai.org/) blockchain MCP tooling for an autonomous agent.

It handles keypair generation and import, chain configuration (testnet/mainnet), live chain registry data from the [Cosmos chain registry](https://github.com/cosmos/chain-registry), and configuring five MCP servers (all bundled in [@manifest-network/manifest-mcp-node](https://www.npmjs.com/package/@manifest-network/manifest-mcp-node)) so the agent can interact with the configured chain. Deployment orchestration (plan + confirm + broadcast + recovery + persistence) lives in [`@manifest-network/manifest-agent-core`](https://www.npmjs.com/package/@manifest-network/manifest-agent-core) and is surfaced through the `manifest-agent` MCP server's `*_orchestrated` tools via MCP elicitation.

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

After installing, the five MCP servers will appear in `/mcp` but **all five will fail until you initialize**. That's expected — they need a `config.json` that doesn't exist yet. Run `/manifest-agent:init-agent` first.

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

After setup, **restart Claude Code** (or run `/mcp` and reconnect) so the five MCP servers can pick up the new config.

### 2. Verify your setup

Once the MCP servers are connected, verify the agent is wired up correctly:

- **Wallet address & balance** — ask the agent: *"What's my wallet address and balance?"* It will use `mcp__plugin_manifest-agent_manifest-chain__cosmos_query` (`module: bank, subcommand: balances`).
- **Active chain** — the agent can read `$MANIFEST_PLUGIN_DATA/config.json`'s `activeChain` field. You can also infer it from the `mcp__plugin_manifest-agent_manifest-chain__cosmos_query` results.
- **Saved deployments** — `$MANIFEST_PLUGIN_DATA/manifests/` lists one JSON wrapper per past deployment (named `<lease_uuid>.json`). The `troubleshoot-deployment` skill includes a saved-manifest picker.

`$MANIFEST_PLUGIN_DATA` resolves to `~/.claude/plugins/data/<plugin-id>/` and is exposed to scripts as `$MANIFEST_PLUGIN_DATA`. It's where all your runtime state lives — config, keys, chain data, saved deployments. The plugin root is read-only; nothing is written to your clone or marketplace cache.

### 3. Fund your wallet

**Testnet** — request tokens from the testnet faucet via the agent:

> "Use the testnet faucet to fund my wallet."

The agent will call `mcp__plugin_manifest-agent_manifest-chain__request_faucet` (intentionally not gated by the broadcast permission prompt — testnet tokens have no value).

**Mainnet** — fund your wallet's address externally (exchange, bridge, or transfer from another wallet). The agent has no built-in funding mechanism for mainnet.

## Deploying an app

Once your wallet is funded, you deploy in two steps: author a spec file, then deploy it. The orchestrated deploy tool requires a complete `DeploySpec` (the agent-core `validateSpec()` check runs first), so the two-step flow is the supported path.

### Step 1 — Author a spec

```
/manifest-agent:author-manifest
```

Walks you through choosing single-service vs multi-service stack, picking a SKU, entering image refs, ports, env vars, optional custom domain, etc. Saves the spec to `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json` (or a user-chosen absolute path). The file is plain JSON — hand-edit it, version-control it, generate it from a script, share it across deploys.

### Step 2 — Deploy

```
/manifest-agent:deploy-app /path/to/the/saved-spec.json
```

The orchestrated tool handles plan rendering, fee itemization, dual-tx broadcast (when `customDomain` is set), partial-success recovery, and manifest persistence end-to-end via MCP elicitation. Claude Code first evaluates host permission for the outer orchestrated call. After execution starts, the server requests native UI confirmation for the deployment plan, any mainnet warning, and recovery choices. Internal SDK operations do not produce separate host permission events.

### Sensitive env values (file-pipe pattern)

For secrets like database passwords, the env prompt in `/manifest-agent:author-manifest` offers a "From a file" option. Create a dotenv file in a separate terminal first:

```bash
cat > /tmp/wordpress.env
WORDPRESS_DB_HOST=mysql
WORDPRESS_DB_PASSWORD=hunter2
^D
chmod 600 /tmp/wordpress.env
```

Then tell the agent the path. Values flow through a script pipe into the spec file; they never enter the chat input box and the agent never echoes them in summaries. Mirrors the mnemonic-import pattern from `init-agent` / `import-key`.

Note: env values still appear in the `deploy_app_orchestrated` MCP tool call args at broadcast time — eliminating that exposure entirely needs upstream MCP changes.

#### Spec file shape

The spec is the same JSON shape `mcp__plugin_manifest-agent_manifest-fred__build_manifest_preview` and `mcp__plugin_manifest-agent_manifest-fred__deploy_app` accept:

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

The host and orchestrated tool handle different parts of approval:

1. **Host permission** — the plugin's PreToolUse hook requests permission for `deploy_app_orchestrated` before execution. Denial stops the call before the server receives it.
2. **Readiness check** — once allowed, the orchestrator checks deployment prerequisites; blockers surface as MCP errors.
3. **Plan elicitation** — Claude Code renders the server's native request with the deployment plan, itemized estimated fees, and wallet/credit balances, then returns your response.
4. **Mainnet warning** (mainnet only) — the server requests additional acknowledgement of real-funds spending through native elicitation.
5. **Deployment** — the server creates the lease, optionally assigns the domain, and uploads the manifest. These steps can partially succeed. On success it persists a saved manifest at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` and returns connection details.

The agent does not need to repeat or forward native elicitation prompts. The hook sees the outer tool call and cannot inspect its internal SDK operations or verify that a fee recap was displayed. Host prompt behavior must be validated for the Claude version and permission mode in use; see [approval validation](docs/approval-validation.md).

Failed deploys (partial-success — lease created but manifest upload failed) raise a recovery-choice elicitation prompt: retry set-domain + upload, salvage without domain, or close the lease.

## Custom domains

Attach an FQDN to a lease item so users reach the app via your own hostname instead of the provider-assigned subdomain. Available at deploy time (set via `customDomain` in the spec or in any of the interactive flows) and standalone via `/manifest-agent:manage-domain` after the lease exists.

```
/manifest-agent:manage-domain    # interactive: set / clear / lookup
```

`manage-domain` (set/clear path) routes through the orchestrated tool, which runs a warn-only DNS pre-check before broadcasting — it queries A/AAAA/CNAME records for the FQDN with a 5-second timeout and surfaces the result, but does not block the broadcast. The chain is the authoritative arbiter of FQDN format and reservation; DNS resolution affects only browser routing, not the chain claim. The lookup path calls `lease_by_custom_domain` directly (read-only, ungated by the permission prompt).

When `customDomain` is set, the orchestrated tool performs `create-lease` followed by `set-item-custom-domain` as separate transactions. They are sequential and can partially succeed: lease creation is not rolled back if domain assignment fails. The native plan prompt itemizes both estimated fees and their total before execution of these transactions. Host permission applies to the outer orchestrated call.

### DNS setup happens AFTER the deploy

You can't point your CNAME until you know the provider's ingress hostname, which is only assigned once `deploy_app` succeeds. The flow:

1. Deploy with `customDomain` set in the spec.
2. Note the provider FQDN from the success block.
3. Set your CNAME (or A record for an apex) at the provider FQDN.
4. Wait for DNS to propagate.
5. TLS is provisioned by the provider after the lease item picks up the domain — typically a few minutes after both the chain claim and DNS are in place.

### Partial-success failure

The upstream `deploy_app` runs `create-lease` → `set-item-custom-domain` → manifest upload → readiness poll. If anything after `create-lease` fails (most commonly the FQDN is already claimed by another tenant — the upstream `Deploy partially succeeded:` error), the lease was created on-chain but the manifest was NEVER uploaded, so no app is running yet.

The orchestrated tool detects this case, queries the lease state, and offers state-aware recovery via an MCP elicitation prompt:

- **Retry set-domain + upload** — re-attach the domain then upload the manifest via `update_app`.
- **Salvage without domain** — skip the domain; upload the manifest now so the lease starts serving.
- **Cancel/Close the lease** — uses `billing cancel-lease` for `LEASE_STATE_PENDING`, and the `close_lease` MCP tool for `LEASE_STATE_ACTIVE`.

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
| `/manifest-agent:deploy-app <path>` | Deploy a containerized app end-to-end via `mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated`. Required argument: path to a JSON spec file produced by `/manifest-agent:author-manifest`. The orchestrated tool requires a complete `DeploySpec` (`validateSpec()` runs first), so non-file input directs at author-manifest. Plan / confirm / partial-success recovery via MCP elicitation; manifest persistence via `MANIFEST_AGENT_DATA_DIR` |
| `/manifest-agent:author-manifest` | Build and validate a Fred deployment spec interactively (single-service or multi-service stack). Saves a JSON spec file (default location `$MANIFEST_PLUGIN_DATA/manifests-drafts/`) ready to feed to `/manifest-agent:deploy-app`. Optionally collects a custom domain (FQDN + service for stacks) |
| `/manifest-agent:manage-domain` | Set, clear, or look up the custom domain (FQDN) on an existing lease item. Set/clear request host permission before the orchestrated call, then request native action confirmation and verify on-chain state; lookup is read-only |
| `/manifest-agent:troubleshoot-deployment` | Bundle status, diagnostics, and recent logs for a deployed lease into a unified report. Lease picker includes a "lookup by custom domain" option |
| `/manifest-agent:restart-app [<lease-uuid>]` | Restart a running app via its provider without closing the lease. Optional argument: a lease UUID. Refuses on terminal leases; goes through textual confirm + permission prompt; verifies post-restart provision status |
| `/manifest-agent:list-releases [<lease-uuid>]` | Read-only — show the on-provider release/version history for a deployed lease as a Markdown table sorted newest first. Rolling back a release is out of scope |
| `/manifest-agent:balance [<bech32-tenant>]` | Read-only — show wallet balances, credit balance, burn rate, and runway hours. Defaults to the agent's own address; pass a bech32 to query another tenant |
| `/manifest-agent:list-providers [--all]` | Read-only — list registered providers on the active chain. Default surfaces active providers only; `--all` includes inactive entries |
| `/manifest-agent:journal` | Read-only audit-trail query. Filter by date / skill / lease UUID / outcome / signer. Markdown or JSONL output. Records are written by every state-changing skill at the end of each invocation |

## MCP servers

Once configured, the plugin provides five MCP servers, all launched from binaries bundled in `@manifest-network/manifest-mcp-node`:

| Server | Description |
|---|---|
| `manifest-chain` | Chain queries, bank send, testnet faucet |
| `manifest-lease` | Compute leasing, custom domains |
| `manifest-fred` | Deploy / restart / update apps |
| `manifest-cosmwasm` | MFX ↔ PWR conversion via CosmWasm |
| `manifest-agent` | Orchestrated `deploy_app` / `manage_domain` / `troubleshoot_deployment` / `close_lease` flows via MCP elicitation; coordinates server-side SDK operations with plan + confirmation + recovery + verification |

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
                             │  manifest-mcp-agent      │ ← wraps deploy /
                             │                          │   manage-domain /
                             │                          │   troubleshoot /
                             │                          │   close-lease via
                             │                          │   manifest-agent-core
                             └──────────────────────────┘
```

- **Plugin root is read-only** in production (marketplace cache). All mutable state lives in `$MANIFEST_PLUGIN_DATA` — Claude Code's per-plugin persistent data directory at `~/.claude/plugins/data/<id>/`. The directory survives plugin updates and is cleaned on uninstall.
- **Dependencies** (`@cosmjs/proto-signing`, `@manifest-network/manifest-mcp-node`, `request-filtering-agent`) are installed to `$MANIFEST_PLUGIN_DATA/node_modules/` automatically by the SessionStart hook (diff-checked against the plugin's bundled `package.json` on every session start), not in the plugin directory. The umbrella package now includes `manifest-mcp-agent` as a peer dep.
- **MCP servers** are launched by a wrapper script (`start-server.cjs`) that reads `config.json` and passes the appropriate environment variables to the server binary. The `manifest-agent` server additionally gets `MANIFEST_AGENT_DATA_DIR=$MANIFEST_PLUGIN_DATA` (so `agent-core`'s `saveManifest()` writes wrappers to the same path the read-only helpers index) and `MANIFEST_CHAIN_DATA_FILE` (for denom-map humanization).
- **Orchestration** (plan rendering, fee itemization, partial-success recovery, verify-and-recover, persistence) lives in `@manifest-network/manifest-agent-core` — not in the plugin. Skill prose invokes the orchestrated MCP tools and surfaces their typed return values; the plugin no longer owns plan-rendering scripts, classification scripts, or verify-and-recover dispatch.
- **Keypairs** are encrypted with a random 256-bit password and stored with `0600` permissions.

For the full architectural picture (data flow, scripts inventory, hook contracts), see [`CLAUDE.md`](CLAUDE.md).

## Security

- Keyfiles are encrypted using CosmJS wallet serialization (Argon2id + XChaCha20-Poly1305) with a random 32-byte password
- Keyfiles are written with `0600` permissions; the keys directory with `0700`
- `config.json` is written with `0600` permissions (contains the key password)
- Mnemonics are imported from a user-created file via pipe — they never enter Claude's conversation context
- The key password flows between scripts via pipe and never enters the conversation
- The plugin root is never written to
- **Mutating MCP entry points request host permission.** The PreToolUse hook covers direct writes and the outer deploy, domain-management, and close orchestrators. `manage_domain_orchestrated` with `action: "lookup"` is read-only and exempt. Orchestrators request plan/action confirmation through native elicitation after host permission; direct writes use the runtime policy's fee/action recap. The pinned deployment plan includes estimated fees; domain/close recaps do not guarantee numeric estimates. The hook cannot verify prose or intercept the server's internal SDK calls.

### Known trade-offs

- The key password is stored in plaintext in `config.json` (protected by file permissions). A future version may use the OS keychain.
- Hook behavior depends on the Claude version and permission mode. An older [upstream report](https://github.com/anthropics/claude-code/issues/37420) described bypass mode being reset after an `ask` decision; its behavior on current releases has not been established here. See [approval validation](docs/approval-validation.md) for what local tests cover and what requires a real host run.
- The hook is an MCP entry-point guard, not signer isolation. The password and keyfile remain available to processes with access to the plugin data directory; shell commands or direct SDK calls do not pass through this MCP hook.
- Env values supplied via the file-pipe pattern stay out of chat input and prose summaries, but they DO enter the agent's API context as part of the `build_manifest_preview` and `deploy_app` MCP tool call args at validation/broadcast time. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch naming, commit conventions, and the PR checklist. For testing, see [`docs/testing.md`](docs/testing.md). For the release flow, see [`docs/release.md`](docs/release.md). The architectural overview is in [`CLAUDE.md`](CLAUDE.md).

## License

MIT

## Author

[The Lifted Initiative](https://liftedinit.org)

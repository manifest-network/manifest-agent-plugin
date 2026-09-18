# manifest-agent

A plugin for [Claude Code](https://claude.ai/code) and Codex that sets up [Manifest](https://manifestai.org/) blockchain MCP tooling for an autonomous agent.

The native Codex package is built from the same workflows and runtime. See
[Codex installation and usage](docs/codex.md) and the
[host acceptance matrix](docs/host-acceptance.md). The Codex release archive
remains gated on interactive UI and live testnet evidence;
pending Codex acceptance does not block Claude-only releases. Examples
below use Claude Code's `/manifest-agent:<skill>` invocation; Codex uses
`$manifest-agent:<skill>`.

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

- [Claude Code](https://claude.ai/code), or Codex with native plugin discovery and MCP form elicitation (see the host matrix for tested surfaces)
- Stable Node.js >= 22.19.0 (Node 24 is also tested)
- Bash for the shipped hook and workflow commands
- An unlocked OS credential store; Linux also requires `secret-tool` (libsecret).
  See [credential setup and the explicit headless fallback](docs/identity.md).

Release acceptance covers Linux terminals. Native macOS Keychain and Windows
Credential Manager integration is implemented but has not been tested on those
systems; it is not part of the verified 0.5.0 platform scope.

## Installation

Run the terminal examples in Bash. Assignments such as `NAME=$(...)` use POSIX
shell syntax and do not work as written in fish. From fish, run `bash` first
and stay in that Bash session through any temporary-file cleanup.

### Codex

```bash
npm run build:codex
codex plugin marketplace add ./dist/codex
codex plugin add manifest-agent@manifest
```

Run these from this repository, then open a new thread and invoke
`$manifest-agent:init-agent`. Codex defaults to a separate persistent data
directory and never imports Claude's wallet or chain selection automatically.
See [the Codex guide](docs/codex.md) for overrides, upgrades and recovery.

The following installation and quick-start instructions are for Claude Code.

### From a marketplace

```bash
# Add a marketplace that includes this plugin, then:
# /plugin install manifest-agent@<marketplace-name>
```

### For development

```bash
git clone https://github.com/manifest-network/manifest-agent-plugin.git
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

Reinitializing preserves a custom gas multiplier after either generating or
importing a wallet. `/manifest-agent:import-key` also retains the existing chain
and gas price. The config writer saves the wallet and previous multiplier
atomically, so an interruption or later rerun cannot lose the value. An unset
multiplier keeps the default `1.5`. Both workflows verify the saved settings
before reporting completion. If that read fails, the operation is reported and
journaled as partial with the confirmed address and chain and unverified gas
settings. Resolve the diagnostic and retry only the status read, without
generating or importing another wallet.

After setup, **restart Claude Code** (or run `/mcp` and reconnect) so the five MCP servers can pick up the new config.

### 2. Verify your setup

Once the MCP servers are connected, verify the agent is wired up correctly:

- **Wallet address & balance** — ask the agent: *"What's my wallet address and balance?"* It will use `mcp__plugin_manifest-agent_manifest-chain__cosmos_query` (`module: bank, subcommand: balances`).
- **Active chain** — run `node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status` in the host's tool shell to inspect safe configuration fields. Do not read config directly into conversation: a legacy copy can still contain a wallet password.
- **Saved deployments** — `$MANIFEST_PLUGIN_DATA/manifests/` lists one JSON wrapper per past deployment (named `<lease_uuid>.json`). The `troubleshoot-deployment` skill includes a saved-manifest picker.

`$MANIFEST_PLUGIN_DATA` resolves to `~/.claude/plugins/data/<plugin-id>/` and is exposed to scripts as `$MANIFEST_PLUGIN_DATA`. It's where all your runtime state lives — config, keys, chain data, saved deployments. The plugin root is read-only; nothing is written to your clone or marketplace cache.

On new Claude sessions, SessionStart supplies the configured address, chain,
gas denom and current gas-token balance as model context and a user message.
Low testnet balances produce a faucet hint; startup
does not request funds automatically. Offline or failed queries show an unavailable
balance. See [session identity and credentials](docs/identity.md).

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

Walks you through choosing single-service vs multi-service stack, picking a SKU,
entering image refs, ports, env vars and an optional custom domain. Saves the spec
to `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json`, or an absolute path
under the drafts directory or system temporary directory. The file is plain
JSON; hand-edit it or copy it into your app repository for version control.

For each image, authoring recommends a user-supplied
`name@sha256:<64 hex characters>` reference and preserves it exactly. To
use a mutable tag, choose **Keep mutable tag** explicitly. The recap lists
every saved image and distinguishes supplied digests from unresolved tags.
The local syntax check rejects malformed digests before saving or deploying;
it accepts `sha256:` followed by 64 lowercase hex characters and does not
verify registry contents or availability.
Automatic tag resolution is not available in the pinned MCP 0.22.0 runtime.
Preview validates the manifest; its `meta_hash_hex` hashes the manifest JSON
and does not pin an image tag. The deployment plan currently shows only
the primary image reference; the subsequent native confirmation already
lists every service's full image reference, including supplied digests.
Automatic tag resolution and per-service resolution status depend on
[ENG-954](https://linear.app/liftedinit/issue/ENG-954).

The draft records the compute SKU and provider UUIDs, so identical SKU names
remain distinct choices. Optional storage is selected on that provider and
its identity is recorded for comparison before deployment. Storage still
deploys by name; duplicate storage names within one provider require a
different choice until the upstream deployment tool supports storage UUIDs.
The catalog does not identify SKU types; use a storage SKU documented by
the provider. The current deployment confirmation omits storage pricing,
and its transaction estimate excludes the additional storage lease item.

### Step 2 — Deploy

```
/manifest-agent:deploy-app /path/to/the/saved-spec.json
```

The orchestrated tool handles plan rendering, fee itemization, dual-tx broadcast (when `customDomain` is set), partial-success recovery, and manifest persistence end-to-end via MCP elicitation. Claude Code first evaluates host permission for the outer orchestrated call. After execution starts, the server requests native UI confirmation for the deployment plan, any mainnet warning, and recovery choices. Internal SDK operations do not produce separate host permission events.

### Sensitive env values (file-pipe pattern)

For secrets like database passwords, the env prompt in `/manifest-agent:author-manifest`
offers a "From a file" option. Create a dotenv file in a separate Bash terminal.
If your usual shell is fish, run `bash` in that terminal before the commands
below and stay in that Bash session through temporary-file cleanup:

```bash
umask 077
ENV_INPUT_PATH=$(mktemp)
cat > "$ENV_INPUT_PATH"
WORDPRESS_DB_HOST=mysql
WORDPRESS_DB_PASSWORD=hunter2
# press Enter, then Ctrl+D
printf '%s\n' "$ENV_INPUT_PATH"
```

After pressing Ctrl+D, tell the agent the printed path. `mktemp`
creates a fresh file with mode `0600`; an older file's permissions cannot carry
over. Values flow through a script pipe into the spec file; they never enter
the chat input box and the agent never echoes them in summaries. This uses the
same fresh-file pattern as mnemonic import in `init-agent` / `import-key`.
After a successful merge, remove the input file from the same Bash session with
`rm -- "$ENV_INPUT_PATH"`. If you repeat the recipe for several services,
remove each printed path; `ENV_INPUT_PATH` names only the most recent file.

Note: env values still appear in `build_manifest_preview` and
`deploy_app_orchestrated` MCP tool arguments during validation and deployment.
Eliminating that exposure entirely needs upstream MCP changes.

#### Spec file shape

The saved file is a `DeploySpec` passed as `{spec: ...}` to
`deploy_app_orchestrated`. It requires `size` and either `image` or `services`.
Preview receives only the manifest fields (for an authored stack,
`{services: spec.services}`); the direct Fred deployment tool has a separate
argument contract. Compute selectors and custom-domain fields below are
deployment metadata, not preview inputs.

```jsonc
// Single-service
{
  "size": "<provider SKU name>",
  "skuUuid": "<selected compute SKU UUID>",
  "providerUuid": "<selected provider UUID>",
  "image": "docker.io/library/nginx:1.27",
  "port": 80,
  "env": { "FOO": "bar" },               // optional
  "labels": { "app": "demo" },           // optional
  "command": ["/bin/sh"],                // optional
  "args": ["-c", "..."],                 // optional
  "health_check": { /* … */ },           // optional
  "storage": "<provider storage SKU name>", // optional
  "tmpfs": { /* … */ },                  // optional
  "init": false,                         // optional
  "customDomain": "app.example.com"      // optional, see below
}

// Multi-service stack
{
  "size": "<provider SKU name>",
  "skuUuid": "<selected compute SKU UUID>",
  "providerUuid": "<selected provider UUID>",
  "services": {
    "wordpress": { "image": "...", "ports": { "80/tcp": { "ingress": true } }, "env": { /* … */ } },
    "mysql":     { "image": "...", "ports": { "3306/tcp": {} }, "env": { /* … */ } }
  },
  "storage": "<provider storage SKU name>", // optional
  "customDomain": "app.example.com",     // optional
  "serviceName": "wordpress"             // required when customDomain set on a stack
}
```

The Fred schema validates container manifest fields during preview. The
orchestrator separately validates the complete deployment spec and checks the
selected catalog entries before showing its plan. Preview does not establish
image availability, provider readiness, domain availability or deployment cost.

### What happens before broadcast

The host and orchestrated tool handle different parts of approval:

1. **Host permission** — the plugin's PreToolUse hook requests permission for `deploy_app_orchestrated` before execution. Denial stops the call before the server receives it.
2. **Readiness check** — once allowed, the orchestrator checks deployment prerequisites; blockers surface as MCP errors.
3. **Plan elicitation** — Claude Code renders the server's native request with the deployment plan, itemized estimated fees, and wallet/credit balances, then returns your response.
4. **Mainnet warning** (mainnet only) — the server requests additional acknowledgement of real-funds spending through native elicitation.
5. **Deployment** — the server creates the lease, optionally assigns the domain, and uploads the manifest. These steps can partially succeed. On success it persists a saved manifest at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` and returns connection details.

The agent does not need to repeat or forward native elicitation prompts. The hook sees the outer tool call and cannot inspect its internal SDK operations or verify that a fee recap was displayed. Host prompt behavior must be validated for the Claude version and permission mode in use; see [approval validation](docs/approval-validation.md).

When a failure leaves a lease behind, the orchestrator can request a
state-dependent recovery choice, such as retrying upload, continuing without
the domain, or closing the lease. Read the typed result even after declining
recovery; that decline does not undo earlier spending.

## Custom domains

Attach an FQDN to a lease item so users reach the app via your own hostname instead of the provider-assigned subdomain. Available at deploy time (set via `customDomain` in the spec or in any of the interactive flows) and standalone via `/manifest-agent:manage-domain` after the lease exists.

```
/manifest-agent:manage-domain    # interactive: set / clear / lookup
```

`manage-domain` (set/clear path) routes through the orchestrated tool, which runs a warn-only DNS pre-check before broadcasting — it queries A/AAAA/CNAME records for the FQDN with a 5-second timeout and surfaces the result, but does not block the broadcast. The chain is the authoritative arbiter of FQDN format and reservation; DNS resolution affects only browser routing, not the chain claim. The lookup path calls `lookup_custom_domain_orchestrated` (read-only, with normal host permissions).

When `customDomain` is set, the orchestrated tool performs `create-lease` followed by `set-item-custom-domain` as separate transactions. They are sequential and can partially succeed: lease creation is not rolled back if domain assignment fails. The native plan prompt itemizes both estimated fees and their total before execution of these transactions. Host permission applies to the outer orchestrated call.

### DNS setup happens AFTER the deploy

You can't point your CNAME until you know the provider's ingress hostname, which is only assigned once `deploy_app` succeeds. The flow:

1. Deploy with `customDomain` set in the spec.
2. Note the provider FQDN from the success block.
3. Set your CNAME (or A record for an apex) at the provider FQDN.
4. Wait for DNS to propagate.
5. Follow the provider's custom-domain and TLS instructions, then verify HTTPS.
   The release acceptance covers on-chain domain assignment and clearing;
   custom DNS and TLS provisioning were not tested.

### Partial-success failure

The upstream `deploy_app` runs `create-lease` → `set-item-custom-domain` → manifest
upload → readiness poll. A failure after lease creation can leave a paid lease.
A domain-assignment failure occurs before upload, but later failures can leave
an uploaded or running app. Preserve the lease and transaction IDs and inspect
its current state before retrying.

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

### Updating gas fee token or multiplier

```
/manifest-agent:set-gas-price
```

Lets you change:

- **Gas fee token** — `umfx` (default) or factory `upwr`. Both are valid fee tokens on Manifest.
- **Gas price** — selecting a fee token uses its registry minimum price.
  A custom full `<amount><denom>` price can be set with the
  [configuration helper](docs/scripts.md).
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

Queries the lease's chain state through the read-only troubleshooting
orchestrator. Provider status, diagnostics and logs are separate optional checks.
The lease picker accepts a UUID, active leases, saved manifests or a custom
domain. Cleanup uses a separately confirmed `close_lease_orchestrated` call.

### Listing your saved deployments

There's no dedicated "list" command, but the saved manifests live at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` (one file per past deploy). The `troubleshoot-deployment` skill's lease picker enumerates them with redacted summaries (env keys, never values). You can also list them yourself:

```bash
ls ~/.claude/plugins/data/manifest-agent*/manifests/
```

The wrappers persist after a lease expires or is closed — they're a historical record, not a live state cache.

### Updating the plugin

Use Claude Code's plugin controls to update a marketplace installation. Your
`$MANIFEST_PLUGIN_DATA` directory survives plugin updates, so config, keys, and
saved deployments are preserved. The SessionStart hook checks the tracked
package and lockfile plus installed dependency files. It runs the shared setup
command when dependencies changed, are missing, or were left incomplete. Setup
installs with `npm ci --omit=dev --ignore-scripts` into the data directory,
leaving the plugin root untouched.

For development installs (`claude --plugin-dir`), pull the latest commits in your clone and restart Claude Code. MCP launchers wait for concurrent SessionStart setup, including a short grace period before its lock exists. If an unusually slow install exceeds startup's 25-second wait or the host timeout, let setup finish and reconnect the MCP servers.

The MCP launcher uses your selected config as the source of chain, gas-price/multiplier and
wallet settings. `COSMOS_MAX_GAS` remains an explicit operator gas-ceiling
override; the upstream package validates it. Inherited endpoint/wallet variables and a workspace `.env`
cannot silently override it. An explicitly empty password is passed through;
MCP 0.22.0 still rejects empty-password encrypted keyfiles, so preserve the
original password if your wallet is encrypted.

### Uninstalling

`/plugin uninstall manifest-agent` (or the equivalent UI action) removes the plugin and its data directory, including your config and keyfiles. **Back up `$MANIFEST_PLUGIN_DATA` and its referenced OS credential store before uninstalling** to preserve the wallet. With the explicit file fallback, include `credentials/`. Config plus an encrypted keyfile alone is insufficient; the original mnemonic is the independent recovery option. See [backup and recovery](docs/identity.md#backup-and-recovery).

To reinstall while retaining Claude's data, use the CLI's `--keep-data` option:

```bash
claude plugin uninstall 'manifest-agent@<marketplace-name>' --keep-data
claude plugin install 'manifest-agent@<marketplace-name>'
```

Replace `<marketplace-name>` with the marketplace shown by `claude plugin list`,
then start a new Claude session. Codex's `codex plugin remove manifest-agent@manifest`
followed by `codex plugin add manifest-agent@manifest` preserves its separate
data directory. Both current-version paths and automatic runtime repair were
checked with encrypted wallets and saved records; see
[current-install acceptance](docs/current-install-acceptance.md).

## Skills reference

| Skill | Description |
|---|---|
| `/manifest-agent:init-agent` | Full interactive setup — install deps, choose chain, generate or import key |
| `/manifest-agent:import-key` | Import an existing mnemonic phrase into the agent config |
| `/manifest-agent:switch-chain` | Switch between testnet and mainnet |
| `/manifest-agent:set-gas-price` | Select the gas fee token at its registry minimum price and/or change the gas multiplier |
| `/manifest-agent:refresh-registry` | Re-fetch chain data from the Cosmos chain registry |
| `/manifest-agent:deploy-app <path>` | Deploy a containerized app end-to-end via `mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated`. Required argument: path to a JSON spec file produced by `/manifest-agent:author-manifest`. The orchestrated tool requires a complete `DeploySpec` (`validateSpec()` runs first), so non-file input directs at author-manifest. Plan / confirm / partial-success recovery via MCP elicitation; manifest persistence via `MANIFEST_AGENT_DATA_DIR` |
| `/manifest-agent:author-manifest` | Build and validate a Fred deployment spec interactively (single-service or multi-service stack). Saves a JSON spec file (default location `$MANIFEST_PLUGIN_DATA/manifests-drafts/`) ready to feed to `/manifest-agent:deploy-app`. Optionally collects a custom domain (FQDN + service for stacks) |
| `/manifest-agent:manage-domain` | Set, clear, or look up the custom domain (FQDN) on an existing lease item. Set/clear request host permission before the orchestrated call, then request native action confirmation and verify on-chain state; lookup is read-only |
| `/manifest-agent:troubleshoot-deployment` | Show a chain-state report and optionally query provider status, diagnostics, and logs separately. Lease picker includes a "lookup by custom domain" option |
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

**Before init-agent**: Expected. The servers need `$MANIFEST_PLUGIN_DATA/config.json` (which holds the chain choice and credential reference — created by init-agent, never created automatically). Run `/manifest-agent:init-agent` first, then restart. Dependencies are installed automatically by SessionStart; onboarding also runs the same setup command before using them. To repair a failed or incomplete install, run:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/setup-runtime.cjs"
```

For an npm install failure, inspect `$MANIFEST_PLUGIN_DATA/.last-install.log` when the diagnostic points to it. Handled failures retain logs only when they contain output. If npm itself is missing, install it alongside Node as the diagnostic instructs. Repair preserves your config, keys, drafts, journal, and saved deployments; you do not need to generate a new wallet.

**After init-agent**: Check your Node.js version. The MCP servers require **Node.js 22.19.0+**. If your system default `node` is older, the wrapper exits with a `Node 22.19.0+ required (found X.X.X)` error visible in the MCP server logs. Verify with `node --version` and update if needed. If you use nvm, run `nvm install 24` and `nvm alias default 24` to set the default.

Setup contention prints the path to `$MANIFEST_PLUGIN_DATA/.runtime-setup.lock`
and waits up to 60 seconds. Setup reclaims locks whose parent and worker have
exited; launchers ignore those locks without removing them. On Linux, recorded
process start times also distinguish reused PIDs. Older locks or platforms without process
identity stay conservative: do not remove a lock while an installer is running.
After verifying that neither its parent nor worker is an installer, a stale lock
can be removed before retrying setup. Setup also bounds retries for malformed
lock paths. Lock-read errors report their startup phase and filesystem code;
inspect the lock in the data directory. Runtime errors identify dependency failures
and invalid completion schema, fingerprint, platform or file inventory. Unexpected
startup failures report their phase and a recognized error code when available,
without printing config values. Switching between supported stable Node majors
does not itself require reinstalling this JavaScript-only runtime.

Abrupt launcher termination, including SIGKILL, SIGQUIT or SIGABRT, can skip
exit cleanup and leave an empty private `manifest-mcp-cwd-*` directory in the
system temp directory. Normal exits clean it up. The launcher forwards
SIGTERM/SIGINT/SIGHUP to its child and cleans up when that child exits; the
OS temp cleaner can remove leftovers from abrupt termination.

### "Out of gas" during a broadcast

For a direct `cosmos_tx` call, the runtime policy permits one retry with
`gas_multiplier` raised by `0.1`, after a new fee estimate and confirmation.
Orchestrated operations own their internal retry behavior. A timeout or unclear
deployment outcome requires inspecting the existing lease before any retry.
Use `/manifest-agent:set-gas-price` to change the configured multiplier.

### "Deploy partially succeeded:" error

A deployment failed after creating a lease. Preserve its identifiers and inspect
the typed result and current state; an app may already exist. See
[Partial-success failure](#partial-success-failure) for recovery choices.

### "FQDN already claimed by another tenant"

The custom domain you specified is already attached to another lease on-chain. Choose a different FQDN, or contact the current claimant. Use `/manifest-agent:manage-domain` with the lookup option to see which lease holds it.

### Permission prompts keep firing for read tools

Check the host version, permission mode and exact tool name. The plugin hook
targets reviewed mutations; other prompts can come from host permissions.
An older bypass-mode reset report has not been reproduced in the tested current
host. See [approval validation](docs/approval-validation.md) for the verified scope.

### Credential store unavailable or wallet backup missing

Unlock the OS keychain and reconnect the MCP servers. Linux requires `secret-tool`
and a running Secret Service session. Headless installs can explicitly select
`MANIFEST_CREDENTIAL_STORE=file` for new credentials or legacy migration; existing
keychain references still need that keychain. Config contains a reference, not the
password. Restore the config, encrypted keyfile and referenced credential together,
or re-import your original mnemonic. See [credential recovery](docs/identity.md).

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
- **Dependencies** are installed to `$MANIFEST_PLUGIN_DATA/node_modules/` by the
  shared locked installer. Claude calls it from SessionStart; Codex calls it from
  each launcher. It validates both package manifests and installed dependency
  files, and never installs into the plugin directory.
- **MCP servers** are launched by a wrapper script (`start-server.cjs`) that reads `config.json` and passes the appropriate environment variables to the server binary. The `manifest-agent` server additionally gets `MANIFEST_AGENT_DATA_DIR=$MANIFEST_PLUGIN_DATA` (so `agent-core`'s `saveManifest()` writes wrappers to the same path the read-only helpers index) and `MANIFEST_CHAIN_DATA_FILE` (for denom-map humanization).
- **Orchestration** (plan rendering, fee itemization, partial-success recovery, verify-and-recover, persistence) lives in `@manifest-network/manifest-agent-core` — not in the plugin. Skill prose invokes the orchestrated MCP tools and surfaces their typed return values; the plugin no longer owns plan-rendering scripts, classification scripts, or verify-and-recover dispatch.
- **Keypairs** are encrypted with a random 256-bit password and stored with `0600` permissions.

For the full architectural picture (data flow, scripts inventory, hook contracts), see [`CLAUDE.md`](CLAUDE.md).

## Security

- Keyfiles are encrypted using CosmJS wallet serialization (Argon2id + XChaCha20-Poly1305) with a random 32-byte password
- Keyfiles are written with `0600` permissions; the keys directory with `0700`
- `config.json` is written with `0600` permissions and contains a credential reference;
  passwords use Linux Secret Service, macOS Keychain or Windows Credential Manager.
  Legacy plaintext passwords are migrated after verified storage. An explicit
  headless fallback uses separate private files ([details](docs/identity.md)).
- Mnemonics are imported from a user-created file via pipe — they never enter Claude's conversation context
- The key password flows between scripts via pipe and never enters the conversation
- The plugin root is never written to
- **Mutating MCP entry points request host permission.** The PreToolUse hook covers direct writes and the outer deploy, domain-management, and close orchestrators. `lookup_custom_domain_orchestrated` is the dedicated read-only lookup; the domain mutation tool accepts only set/clear. Orchestrators request plan/action confirmation through native elicitation after host permission; direct writes use the runtime policy's fee/action recap. The pinned deployment plan includes estimated fees; domain/close recaps do not guarantee numeric estimates. The hook cannot verify prose or intercept the server's internal SDK calls.

### Known trade-offs

- The explicit headless file fallback stores recoverable passwords in private files.
  Keychain credentials and decrypted passwords remain accessible to authorized
  processes running as the same user; this is not hardware signer isolation.
- Hook behavior depends on the Claude version and permission mode. An older [upstream report](https://github.com/anthropics/claude-code/issues/37420) described bypass mode being reset after an `ask` decision; its behavior on current releases has not been established here. See [approval validation](docs/approval-validation.md) for what local tests cover and what requires a real host run.
- The hook is an MCP entry-point guard, not signer isolation. The launcher supplies a decrypted password to its MCP child, and processes with access to the credential store and keyfile can use the wallet; shell commands or direct SDK calls do not pass through this MCP hook.
- Env values supplied via the file-pipe pattern stay out of chat input and prose summaries, but they DO enter the agent's API context as part of the `build_manifest_preview` and `deploy_app_orchestrated` MCP tool call args at validation/broadcast time. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch naming, commit conventions, and the PR checklist. For testing, see [`docs/testing.md`](docs/testing.md). For the release flow, see [`docs/release.md`](docs/release.md). The architectural overview is in [`CLAUDE.md`](CLAUDE.md).

## License

MIT

## Author

[The Lifted Initiative](https://liftedinit.org)

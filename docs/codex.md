# Manifest Agent for Codex

Manifest Agent provides the same 14 workflows and pinned MCP 0.22.0 runtime
for Codex and Claude Code. Codex uses a separate native package with explicit
skill and MCP discovery, independent bootstrap, and native form confirmation.
The initial compatibility release still requires the terminal/desktop and
live testnet evidence listed in the repository's `docs/host-acceptance.md`.
Codex CLI 0.153.4's app-server has passed the local fixture matrix; that result
does not establish support for every Codex surface or version.

## Install

Use stable Node 22.19.0+ (Node 24 is also tested), npm, and Codex CLI 0.153.4.
From a checkout of `liftedinit/manifest-agent-plugin`:

```bash
npm run build:codex
codex plugin marketplace add ./dist/codex
codex plugin add manifest-agent@manifest
```

Open a new Codex thread after installation. The generated marketplace is a
distribution directory; these commands register it explicitly. Keep that
directory available. The checkout root remains the Claude plugin and is not
the Codex installation target.

For a release archive, extract `manifest-agent-codex-v<VERSION>.tar.gz`, then
run the same marketplace command against the extracted `codex` directory.
The archive contains `.agents/plugins/marketplace.json` and
`plugins/manifest-agent/`. Do not move the inner plugin out of the marketplace.

The package uses `.codex-plugin/plugin.json`, `.mcp.json`, and
`skills/<name>/SKILL.md`. Relative `cwd: "./"` in each MCP entry resolves to
the installed plugin root; no Claude substitutions or lifecycle hooks are
used. See the [official plugin documentation](https://developers.openai.com/plugins/build/plugins)
and [MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Initialize and use

Start with `$manifest-agent:init-agent`. Choose the chain and generate a
wallet or explicitly import one. Reconnect MCP servers or start a new thread
after changing configuration. All five servers report missing configuration
until initialization is complete; that is expected.

Then use these workflows:

| Task | Codex invocation |
| --- | --- |
| Create and validate a deployment spec | `$manifest-agent:author-manifest` |
| Deploy a complete saved spec | `$manifest-agent:deploy-app /absolute/path/spec.json` |
| Inspect status and troubleshoot | `$manifest-agent:troubleshoot-deployment` |
| Look up, set or clear a domain | `$manifest-agent:manage-domain` |
| Restart an active app | `$manifest-agent:restart-app` |
| Check wallet and credit balances | `$manifest-agent:balance` |
| List providers or releases | `$manifest-agent:list-providers`, `$manifest-agent:list-releases` |
| Inspect local operation records | `$manifest-agent:journal` |
| Change wallet, chain or gas price | `$manifest-agent:import-key`, `$manifest-agent:switch-chain`, `$manifest-agent:set-gas-price` |
| Refresh chain metadata | `$manifest-agent:refresh-registry` |

The generated instructions contain concrete Codex MCP names such as
`mcp__manifest-agent__deploy_app_orchestrated`. The host adapter resolves tool
names during packaging. Domain logic and saved-record formats are shared.
Onboarding and configuration skills disable implicit invocation through
`agents/openai.yaml`; invoke them explicitly.

## Data and upgrades

| State | Claude Code | Codex |
| --- | --- | --- |
| Persistent root | Existing `CLAUDE_PLUGIN_DATA` | `MANIFEST_CODEX_DATA`, otherwise `${XDG_DATA_HOME:-$HOME/.local/share}/manifest-agent/codex` |
| Config and wallet | Existing location preserved | Separate config and encrypted wallet |
| Chain metadata and dependencies | Under the Claude data root | Under the Codex data root |
| Drafts, saved manifests and journals | Under the Claude data root | Under the Codex data root |
| Shared implementation | Repository scripts and workflow sources | Generated copy of the same scripts and workflows |

Paths supplied through `MANIFEST_CODEX_DATA` or `XDG_DATA_HOME` must be
absolute. Set the override in the environment that launches Codex, before
starting its MCP servers. Codex ignores ambient `CLAUDE_PLUGIN_DATA` and
`MANIFEST_PLUGIN_DATA`; starting it from a Claude shell cannot select that
shell's wallet by accident.

The supported arrangement isolates all mutable data by host. Do not point
both hosts at the same directory: the installer lock protects dependencies,
but it does not serialize chain selection or wallet changes in two hosts.
There is no automatic migration, wallet import or chain selection. To reuse
a spec, explicitly copy that draft to the other host and revalidate its
provider/SKU selection. To reuse a wallet, explicitly run the import workflow
and select the chain; importing a wallet does not duplicate its chain funds.

Rebuild after updating the checkout. Remove and reinstall the plugin from
the generated marketplace, then open a new thread:

```bash
npm run build:codex
codex plugin remove manifest-agent@manifest
codex plugin add manifest-agent@manifest
```

Uninstall/reinstall replaces package code; data remains in the persistent
directory. Each server calls the same locked `setup-runtime.cjs` installer.
Upgrades and repairs preserve config, keys, drafts, saved manifests and
journals. Do not delete the data directory to repair an installation.

For manual setup or repair, resolve the installed package root (the directory
containing `.codex-plugin/`) and run in the same shell:

```bash
# Set this to your installed package path.
MANIFEST_PLUGIN_ROOT=/absolute/path/to/manifest-agent
eval "$(node "$MANIFEST_PLUGIN_ROOT/scripts/host-env.cjs" codex --shell)"
node "$MANIFEST_PLUGIN_ROOT/scripts/setup-runtime.cjs"
```

Skills load these exports in each shell call because Codex does not use
Claude's environment file. The helper prints only paths and host/session
metadata; it does not read wallet configuration. Journal session IDs come
from `CODEX_THREAD_ID` when supplied by the host, otherwise remain null.

## Confirmation, progress and recovery

The native MCP configuration uses the host's `writes` approval mode. A second
boundary in the adapter checks form-elicitation capability before forwarding
any reviewed mutation. Direct mutations, including provider restarts, wait
for an accepted native form. The three mutating orchestrators use upstream
plan, mainnet and recovery forms. Missing form support, malformed responses,
decline, cancel or a confirmation timeout cannot authorize a direct write.

Headless clients may advertise elicitation but automatically decline it.
Read-only tools remain usable; interactive mutations require a host that
presents forms to the user. Never answer native confirmation on the user's
behalf or replace a failed orchestrator call with a direct mutation. The
testnet faucet remains the documented exception to mutation confirmation.

Server startup allows 180 seconds; tool calls allow 1,800 seconds. Native
direct confirmation waits up to 600 seconds. Upstream elicitation defaults
to 600 seconds and accepts `MANIFEST_AGENT_ELICIT_TIMEOUT_MS`. A longer
per-prompt setting does not extend the outer tool timeout. For slow initial
downloads, run manual setup first, then reconnect. Setup waiters retain the
shared installer's existing 60-second lock acquisition limit.

The adapter forwards upstream progress, log messages, cancellation and typed
results. Display of progress and late cancellation logs depends on the host
surface; the acceptance matrix records what has actually been observed.
Transport loss or timeout is not evidence that an operation never ran.

| Outcome | Report and next action |
| --- | --- |
| Complete and active | Report verified state, returned URLs and saved record path. |
| Paid partial | Preserve lease/transaction IDs and recovery outcome; report which readiness or domain check remains unconfirmed. |
| Unknown after timeout/disconnect | Query the existing lease, provider status and saved records before considering a retry. |
| Cancelled before execution | Report that no mutation was forwarded. |

Cancellation after broadcast does not roll back the lease. A declined recovery
prompt can keep a paid deployment alive. Do not call that a fresh cancellation
with no spend, and do not blindly deploy again.

Configuration controls chain, gas price and wallet. The launcher clears stale
config-owned environment values and prevents workspace `.env` files from
changing the signer. `COSMOS_MAX_GAS`, elicitation timeout and proxy variables
are explicit operator overrides forwarded by the native MCP configuration.

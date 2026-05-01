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
- **set-gas-price** — Change gas fee token, price, and/or gas multiplier
- **refresh-registry** — Re-fetch chain data from Cosmos chain registry
- **author-manifest** — Build + validate a Fred manifest interactively via `build_manifest_preview`; emits a `MANIFEST_PREVIEW` handoff block
- **troubleshoot-deployment** — Bundle `app_status` + `app_diagnostics` + `get_logs` into one report; offers `close_lease` cleanup with `remove-manifest.cjs`
- **deploy-app** — Orchestrates the end-to-end flow: mainnet check → `author-manifest` → DeploymentPlan → confirm → `deploy_app` → `save-manifest.cjs`. On the typical happy path the orchestrator reads connection details (URL, provider) directly from `deploy_app`'s response and skips both `wait_for_app_ready` and `app_status` to avoid extra round-trips; the fallback path calls `wait_for_app_ready` (and then `app_status` for the URL) only when `deploy_app` returns without an active connection. Failure path invokes `troubleshoot-deployment` inline. Single-service v1; multi-service `services` map and resume-partial-deploy are out of scope.

## config.json → MCP env var mapping

`start-server.cjs` maps config fields to env vars for the MCP child process:

| Config path | Env var | Required |
|---|---|---|
| `chains[activeChain].chainId` | `COSMOS_CHAIN_ID` | yes |
| `chains[activeChain].rpcUrl` | `COSMOS_RPC_URL` | yes |
| `chains[activeChain].restUrl` | `COSMOS_REST_URL` | no (omit if falsy) |
| `chains[activeChain].converterAddress` | `MANIFEST_CONVERTER_ADDRESS` | no (omit if falsy) |
| `chains[activeChain].faucetUrl` | `MANIFEST_FAUCET_URL` | no (omit if falsy — only set for testnet; chain server registers `request_faucet` when present) |
| `gasPrice` | `COSMOS_GAS_PRICE` | yes |
| `gasMultiplier` | `COSMOS_GAS_MULTIPLIER` | no (omit if falsy, default 1.5) |
| `agent.keyFile` | `MANIFEST_KEY_FILE` | no (omit if falsy) |
| `agent.keyPassword` | `MANIFEST_KEY_PASSWORD` | no (omit if falsy) |

## Transaction Behavior (runtime policy)

**Do not edit the policy text in this file.** The canonical, runtime-facing transaction policy lives in `scripts/session-start.sh` as a heredoc and is injected into every Claude session via the SessionStart hook. Plugin CLAUDE.md files are developer docs — they are not loaded into sessions that USE the plugin, so any policy written here never reaches the runtime agent. Edit `scripts/session-start.sh` if you need to change the rules.

Two-layer enforcement:

1. **Runtime policy injection (SessionStart)** — `hooks/hooks.json` → `scripts/session-start.sh` writes the policy text to stdout. Claude Code adds stdout from SessionStart hooks to the session's context, so the rules are present from the first turn. This is how the agent learns to call `cosmos_estimate_fee` first, show the fee, and wait for textual confirmation.
2. **Permission prompt safety net (PreToolUse)** — `hooks/hooks.json` → `scripts/pre-tool-use.sh` emits `{hookSpecificOutput.permissionDecision: "ask"}` for broadcast tools, forcing Claude Code to prompt the user regardless of pre-existing permission settings. Deny beats allow in the hook precedence, and "ask" cannot be loosened by settings.json, so this fires even for pre-approved tools.

The heredoc also defines the canonical `DeploymentPlan` block format that the agent must render before calling `deploy_app`. Edit the heredoc, not this file, to change the deployment plan format.

**Tools gated by the PreToolUse hook** (add to the matcher in `hooks/hooks.json` when new write tools ship — each alternative is anchored `^...$` so a future tool whose name contains one of these as a substring is not accidentally gated):

- `mcp__manifest-chain__cosmos_tx`
- `mcp__manifest-cosmwasm__convert_mfx_to_pwr`
- `mcp__manifest-fred__deploy_app`
- `mcp__manifest-fred__restart_app`
- `mcp__manifest-fred__update_app`
- `mcp__manifest-lease__fund_credit`
- `mcp__manifest-lease__close_lease`

Read-only tools and the testnet faucet (`mcp__manifest-chain__request_faucet`) are intentionally not gated.

**Upstream caveat — bypass permissions mode**: The PreToolUse hook returns `permissionDecision: "ask"`, which hits a known Claude Code bug ([anthropics/claude-code#37420](https://github.com/anthropics/claude-code/issues/37420)) where bypass permissions mode is permanently reset after the first hook-triggered prompt. Users running with `--dangerously-skip-permissions` will see the first broadcast prompt correctly, then lose bypass for the rest of the session. This is documented as a known trade-off in `README.md` under "Security → Known trade-offs" and is considered acceptable for this plugin's use case. If the upstream bug is fixed, no code change is needed here — just update the README. Do not try to work around it by switching to `exit 2` or log-only patterns: both defeat the confirmation guarantee.

## Testing Changes

```bash
# Test the plugin locally
claude --plugin-dir .

# Test fetch-chain-registry independently
node scripts/fetch-chain-registry.cjs

# Install deps (one-time, before testing key scripts or MCP wrapper)
mkdir -p ~/.manifest-agent && cp package.json ~/.manifest-agent/
npm install --omit=dev --prefix ~/.manifest-agent

# Test key generation
NODE_PATH=$HOME/.manifest-agent/node_modules node scripts/gen-agent-key.cjs --prefix manifest

# Test MCP wrapper (requires config.json + deps)
node scripts/start-server.cjs chain
```

## Saved manifests

`/manifest-agent:deploy-app` persists the validated manifest after a successful broadcast to `~/.manifest-agent/manifests/<lease_uuid>.json` (mode `0600`, parent dir `0700`). The wrapper schema (version 1) is `{ schema_version, lease_uuid, deployed_at_iso, deployed_at_unix, chain_id, image, size, meta_hash, manifest_json }`. The wrapper itself carries no credentials, but `manifest_json` includes the env values the user supplied during authoring — those can be sensitive (DB URLs, API tokens). Exposure is mitigated by file permissions; skills must not pretty-print `manifest_json` into chat unredacted. Two helpers manage these files:

- `scripts/save-manifest.cjs` — writes the wrapper. Manifest JSON is read from a tmpfile (`--manifest-file`) to keep large JSON off the command line.
- `scripts/remove-manifest.cjs` — unlinks the file. Called by `/manifest-agent:deploy-app` and `troubleshoot-deployment` after a successful `close_lease`. No-op if the file is missing (close_lease may target a lease the agent never deployed).

Naturally-expired leases leave their saved manifest in place — the file is the historical record. There is no periodic sweep.

## Fred manifest schema

`build_manifest_preview` (in `manifest-mcp-fred`) bakes the Fred manifest JSON Schema into the package. If Fred revs the schema, this plugin must bump `manifest-mcp-node` to pick it up. The `refresh-registry` skill only refreshes Cosmos chain-registry data; it does not update the bundled Fred schema.

## Chain Data

Fetched from the Cosmos chain registry (`cosmos/chain-registry` on GitHub):
- Mainnet: `manifest/chain.json` — chain ID `manifest-ledger-mainnet`, RPC at `nodes.liftedinit.app`
- Testnet: `testnets/manifesttestnet/chain.json` — chain ID `manifest-ledger-testnet`, RPC at `nodes.liftedinit.tech`
- Gas: both `umfx` and factory `upwr` token are valid fee tokens. The plugin extracts `fees.fee_tokens[0]` (umfx) by default.
- Faucet: testnet only. The chain registry does not advertise it, so `fetch-chain-registry.cjs` injects `https://faucet.testnet.manifest.network/` directly into the testnet chain data. See the env-var table above for how it propagates.

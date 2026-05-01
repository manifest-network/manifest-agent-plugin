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
- **author-manifest** — Build + validate a Fred deployment spec interactively (single-service or multi-service stack) via `build_manifest_preview`. Saves the spec as a JSON file under `~/.manifest-agent/manifests-drafts/` (or any user-chosen path) for later use with `/manifest-agent:deploy-app`.
- **troubleshoot-deployment** — Bundle `app_status` + `app_diagnostics` + `get_logs` into one report. Saved-manifest section uses `summarize-manifest.cjs` (env values redacted). Offers `close_lease` cleanup with `remove-manifest.cjs`.
- **deploy-app** — Orchestrates the end-to-end flow with two entry points:
    - `/manifest-agent:deploy-app <path>` — load a structured spec JSON file and deploy it.
    - `/manifest-agent:deploy-app` (no arg) — drive a thin inline authoring sequence and deploy in one shot.
  Both paths: validate via `build_manifest_preview` → `evaluate-readiness.cjs` → `render-deployment-plan.cjs` → confirm → `deploy_app` → `classify-deploy-response.cjs` → persist via `save-manifest.cjs` → `format-success.cjs`. On the typical happy path the orchestrator reads connection details directly from `deploy_app`'s response; the fallback path calls `wait_for_app_ready` and `app_status` only when `deploy_app` returns without an active connection. Failure path runs an inline troubleshoot sequence and offers `close_lease`.

## Scripts vs prose

This plugin codifies a split between deterministic operations (CJS scripts in `scripts/`) and ambiguous-decision steps (prose in `skills/<name>/SKILL.md`).

**In scripts:** UUID validation, path traversal guards, file mode + atomic write discipline, JSON parsing and shape validation, structural counting (`manifest-summary.cjs`), readiness evaluation with concrete thresholds (`evaluate-readiness.cjs`), `deploy_app`-response classification (`classify-deploy-response.cjs`), URL extraction from typed connection payloads (`format-success.cjs`), `DeploymentPlan` block rendering (`render-deployment-plan.cjs`), enum decoding (`decode-lease-state.cjs`), redacted summarization (`summarize-manifest.cjs`, `list-saved-manifests.cjs`).

**In prose:** asking the user open-ended questions (image refs, env values, service names), interpreting fuzzy diagnostic signals (the `troubleshoot-deployment` suggestion table), branching on unstable response shapes that require LLM judgment.

The motivation: deterministic logic in prose accumulates LLM-paraphrasing drift across runs and can silently regress when models change. Scripts pin the contract.

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

The heredoc references `scripts/render-deployment-plan.cjs` as the canonical renderer of the `DeploymentPlan` block. Edit that script (not the heredoc, not this file) to change the deployment plan format — both the runtime policy and the orchestrator skill defer to its stdout.

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

## Manifest specs (user-managed)

Deployment specs are plain JSON files in the same shape `mcp__manifest-fred__build_manifest_preview` and `mcp__manifest-fred__deploy_app` accept:

- Single-service: `{ image, port, env?, labels?, command?, args?, health_check?, storage?, tmpfs?, init? }`
- Multi-service: `{ services: { <name>: { image, ports, env?, ... }, ... }, storage?, depends_on? }`

`/manifest-agent:author-manifest` walks the user through building one and saves it (default `~/.manifest-agent/manifests-drafts/<auto-name>.json`, or any user-chosen absolute path). Spec files are user-managed: hand-edit them in `$EDITOR`, version-control them in your app repo, generate them with a script, etc. The plugin doesn't garbage-collect drafts.

`/manifest-agent:deploy-app <path>` consumes a spec file. `/manifest-agent:deploy-app` with no argument drives the inline authoring sequence and deploys in one shot (no draft file written).

Helper: `scripts/save-manifest-draft.cjs` (atomic write + `0600`, refuses to overwrite). Skills should NOT write spec files via `Write` directly — it bypasses the safety checks.

## Saved post-deploy records

After a successful broadcast `/manifest-agent:deploy-app` persists a wrapper at `~/.manifest-agent/manifests/<lease_uuid>.json` (mode `0600`, parent dir `0700`). Wrapper schema v2: `{ schema_version: 2, lease_uuid, deployed_at_iso, deployed_at_unix, chain_id, image, size, meta_hash_hex, format, manifest_json }` where `manifest_json` is the canonical Fred-rendered string (preserves the exact bytes whose SHA-256 is `meta_hash_hex` for audit) and `format` is `"single"` or `"stack"`. The wrapper itself carries no credentials, but `manifest_json` includes the env values the user supplied during authoring — those can be sensitive (DB URLs, API tokens). Exposure is mitigated by file permissions; skills must NOT pretty-print `manifest_json` into chat unredacted.

Helpers (skills should use these instead of reading the wrapper file directly):

- `scripts/save-manifest.cjs` — writes the wrapper. Manifest JSON is read from a tmpfile (`--manifest-file`) to keep large JSON off the command line. Atomic write.
- `scripts/remove-manifest.cjs` — unlinks the file. Called by `/manifest-agent:deploy-app` and `troubleshoot-deployment` after a successful `close_lease`. No-op if the file is missing (close_lease may target a lease the agent never deployed).
- `scripts/list-saved-manifests.cjs` — returns the safe-fields-only listing (never `manifest_json`). Used by `troubleshoot-deployment` as a fallback lease picker.
- `scripts/summarize-manifest.cjs` — redacted structural summary (counts + env *keys*, never values). Used by `troubleshoot-deployment`'s "Saved manifest" appendix.

Naturally-expired leases leave their saved manifest in place — the file is the historical record. There is no periodic sweep. Lease lifecycle (active / closed / expired) is queried fresh from chain state via `app_status` rather than tracked in the wrapper.

## Fred manifest schema

`build_manifest_preview` (in `manifest-mcp-fred`) bakes the Fred manifest JSON Schema into the package. If Fred revs the schema, this plugin must bump `manifest-mcp-node` to pick it up. The `refresh-registry` skill only refreshes Cosmos chain-registry data; it does not update the bundled Fred schema.

## Chain Data

Fetched from the Cosmos chain registry (`cosmos/chain-registry` on GitHub):
- Mainnet: `manifest/chain.json` — chain ID `manifest-ledger-mainnet`, RPC at `nodes.liftedinit.app`
- Testnet: `testnets/manifesttestnet/chain.json` — chain ID `manifest-ledger-testnet`, RPC at `nodes.liftedinit.tech`
- Gas: both `umfx` and factory `upwr` token are valid fee tokens. The plugin extracts `fees.fee_tokens[0]` (umfx) by default.
- Faucet: testnet only. The chain registry does not advertise it, so `fetch-chain-registry.cjs` injects `https://faucet.testnet.manifest.network/` directly into the testnet chain data. See the env-var table above for how it propagates.

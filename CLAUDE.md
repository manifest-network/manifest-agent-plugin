# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin (`manifest-agent`) that bootstraps an autonomous agent for the Manifest blockchain. It installs MCP tooling, manages keypairs, fetches chain registry data, and configures everything so the agent can interact with testnet or mainnet.

## Architecture

**Plugin root is read-only in production.** Marketplace installs copy the plugin to `~/.claude/plugins/cache/`. All mutable state lives in `${CLAUDE_PLUGIN_DATA}` — Claude Code's persistent per-plugin data directory, resolved at runtime to `~/.claude/plugins/data/<id>/` and exposed to scripts as `$MANIFEST_PLUGIN_DATA` (exported by the SessionStart hook).

```
Plugin root (read-only)          Runtime data ($MANIFEST_PLUGIN_DATA)
├── scripts/*.cjs                ├── config.json                  (0600, has key password)
├── skills/*/SKILL.md            ├── keys/agent-*.json            (0600, encrypted wallets)
├── hooks/hooks.json             ├── chains/{mainnet,testnet}.json
├── .mcp.json                    ├── manifests/<lease-uuid>.json  (0600, post-deploy records)
└── package.json                 ├── manifests-drafts/*.json      (0600, user-managed drafts)
                                 ├── journal/<YYYY-MM-DD>.jsonl   (0600, append-only audit trail)
                                 ├── node_modules/                (deps installed here)
                                 └── package.json                 (copied from plugin root)
```

**Data flow**: Skills run scripts → scripts write to `$MANIFEST_PLUGIN_DATA` → MCP wrapper reads `config.json` at startup → spawns MCP binary with computed env vars.

**Dependency resolution**: All scripts are CJS (`.cjs`) because NODE_PATH only works with CommonJS, not ESM. The SessionStart hook exports `NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules` once via `CLAUDE_ENV_FILE`, so every `node` invocation in skill bash blocks (and ad-hoc dev usage) inherits it without per-site prefixing.

**Plugin root + data discovery**: The SessionStart hook exports `MANIFEST_PLUGIN_ROOT` and `MANIFEST_PLUGIN_DATA` via `CLAUDE_ENV_FILE`, mirroring Claude Code's `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` substitutions (which only expand inside `.mcp.json`, hooks, etc., not in scripts). Skills use `$MANIFEST_PLUGIN_ROOT` to locate scripts and `$MANIFEST_PLUGIN_DATA` for runtime files. Scripts read `process.env.MANIFEST_PLUGIN_DATA` (the `_io.cjs` `getDataDir()` helper centralizes the lookup + missing-var error).

**Dependency bootstrap**: The SessionStart hook also runs the docs' diff-check + `npm install` pattern automatically when `package.json` differs between plugin root and `${CLAUDE_PLUGIN_DATA}`. First-run users don't need to call `init-agent` to get a working MCP wrapper.

## Key Patterns

**All scripts use CJS** — `require()`, async IIFE with `.catch(() => process.exit(1))`. Use `getDataDir()` from `_io.cjs` for the data directory path; never compose `homedir() + '.manifest-agent'` (the latter is the legacy pre-v0.5 path).

**Secrets via stdin** — Mnemonics are piped via heredoc (`<<'EOF'`, single-quoted to prevent shell expansion), never as command-line args (visible in `/proc/*/cmdline`).

**Underscore-prefix helpers** — Scripts named `_<topic>.cjs` (`_io.cjs`, `_uuid.cjs`, `_gas-price.cjs`, `_connection.cjs`, `_lease-state.cjs`, `_spec.cjs`, `_lease-items.cjs`, `_https-json.cjs`) are sibling-only modules consumed via `require('./_X.cjs')`. Skills MUST NOT shell out to them. Two non-underscore modules are documented exceptions because they're conceptually renderers that other renderers compose (`humanize-denom.cjs`, `summarize-app-status.cjs`); they're listed in the "Renderer / structural summarizers" subsection of the inventory below.

**MCP wrapper** (`start-server.cjs`) — Reads `config.json`, builds env vars, spawns `$MANIFEST_PLUGIN_DATA/node_modules/.bin/manifest-mcp-<name>` directly (not npx — 30ms vs 800ms startup). Forwards SIGTERM/SIGINT/SIGHUP. Uses `stdio: 'inherit'` so MCP JSON-RPC passes through transparently.

**Falsy env vars** — The wrapper omits optional env vars when falsy rather than setting them to `''`. Empty `MANIFEST_KEY_PASSWORD` causes the MCP server to throw.

## Skills

Invoked as `/manifest-agent:<skill-name>`. All skills guard that `$MANIFEST_PLUGIN_ROOT` is set (Step 0).

- **init-agent** — Full setup: install deps, fetch registry, choose chain, generate or import key, write config
- **import-key** — Import existing mnemonic (requires init-agent first)
- **switch-chain** — Switch testnet/mainnet with mainnet confirmation before write
- **set-gas-price** — Change gas fee token, price, and/or gas multiplier
- **refresh-registry** — Re-fetch chain data from Cosmos chain registry
- **author-manifest** — Build + validate a Fred deployment spec interactively (single-service or multi-service stack) via `build_manifest_preview`. Saves the spec as a JSON file under `$MANIFEST_PLUGIN_DATA/manifests-drafts/` (or any user-chosen path) for later use with `/manifest-agent:deploy-app`.
- **troubleshoot-deployment** — Bundle `app_status` + `app_diagnostics` + `get_logs` into one report. Saved-manifest section uses `summarize-manifest.cjs` (env values redacted). Offers `close_lease` cleanup with `remove-manifest.cjs`.
- **deploy-app** — Orchestrates the end-to-end flow with two entry points:
    - `/manifest-agent:deploy-app <path>` — load a structured spec JSON file and deploy it.
    - `/manifest-agent:deploy-app` (no arg) — drive a thin inline authoring sequence and deploy in one shot.
  Both paths: validate via `build_manifest_preview` → `evaluate-readiness.cjs` → `render-deployment-plan.cjs` → confirm → `deploy_app` → `classify-deploy-response.cjs` → persist via `save-manifest.cjs` → `format-success.cjs`. On the typical happy path the orchestrator reads connection details directly from `deploy_app`'s response; the fallback path calls `wait_for_app_ready` and `app_status` only when `deploy_app` returns without an active connection. Failure path runs an inline troubleshoot sequence and offers `close_lease`. **When `customDomain` is set in the spec**, `deploy_app` broadcasts TWO billing txes atomically (`create-lease` + `set-item-custom-domain`); the orchestrator estimates both fees, shows them line-by-line in the DeploymentPlan, and on partial failure (`Deploy partially succeeded:` MCP error) routes through `classify-deploy-error.cjs` to a retry-set-domain / close-lease / leave-as-is branch.
- **manage-domain** — Set, clear, or look up the custom domain (FQDN) attached to an existing lease item. Three sub-flows via `AskUserQuestion`. Set/clear go through `cosmos_estimate_fee` + textual confirm + PreToolUse + on-chain verification (re-query `leases_by_tenant`, find item, check `customDomain`). Lookup is read-only (`lease_by_custom_domain` reverse query).
- **restart-app** — Restart a running app via `restart_app` without closing the lease. Per the `scripts/session-start.sh` runtime policy, `restart_app` is a provider HTTPS call, NOT a Cosmos broadcast — no gas, no fee estimate, no `cosmos_estimate_fee` step. The skill therefore inlines its own textual confirm rather than loading `references/billing-tx-confirm.md` (that file scaffolds estimable billing-module txes only). The PreToolUse matcher still gates the tool because it's a state-changing op. Pre-call: refuse if `chainState.state` is terminal. Post-call: re-query `app_status` once and surface the new `provision_status`.
- **list-releases** — Read-only call to `app_releases`; renders the version history via `render-releases.cjs` as a Markdown table sorted newest first. True rollback (re-deploying a prior release) is intentionally out of scope — track separately if/when needed.
- **balance** — Read-only call to `credit_balance`; renders wallet balances + credit account state + burn rate + runway hours via `render-balance.cjs` (humanizing denoms via `humanize-denom.cjs`). Optional `$ARGUMENTS` is a bech32 tenant address; default is the agent's own address.
- **list-providers** — Read-only call to `get_providers`; renders the provider table via `render-providers.cjs`. Optional `--all` argument flips `active_only` to false (default surfaces only active providers).
- **journal** — Read-only audit-trail query over `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. Filter by date / skill / lease UUID / outcome / signer. Markdown or JSONL output. The journal is written by every state-changing skill at the end of each invocation; this skill is the canonical reader.

### `references/` files and cross-skill loading

Two flavors of reference file:

- **Skill-local** at `skills/<name>/references/*.md` — for branch detail used by exactly one skill. Today: `skills/deploy-app/references/{spec-input-modes,partial-success-recovery,troubleshoot-after-deploy-failure,set-domain-fee-estimate}.md`.
- **Plugin-root** at `references/*.md` — for prose genuinely shared by two or more skills. Today: `references/readiness-branching.md` (loaded by author-manifest Step 4 + deploy-app Step 5) and `references/billing-tx-confirm.md` (loaded by troubleshoot-deployment Step 6, manage-domain Step 6, and deploy-app's `troubleshoot-after-deploy-failure.md` cleanup section). Plugin-root references aren't documented as a first-class Claude Code pattern, but they resolve correctly inside the plugin cache (the plugin is copied wholesale to `~/.claude/plugins/cache/<id>/<version>/`) and avoid having two skills reach into each other's directories.

When a reference moves between skill-local and plugin-root, update every consumer's `Read` path in the same commit. Each reference's preamble must enumerate its consumers so a reader cold-loading the file can tell whether their context applies.

References must declare a "Variables in scope" section near the top so a reader cold-loading the file knows which orchestrator-supplied symbols (`LEASE_UUID`, `MANIFEST_JSON`, `<activeChain>`, etc.) are expected to be available.

## Scripts vs prose

This plugin codifies a split between deterministic operations (CJS scripts in `scripts/`) and ambiguous-decision steps (prose in `skills/<name>/SKILL.md`).

**In scripts:** UUID validation, path traversal guards, file mode + atomic write discipline, JSON parsing and shape validation, structural counting (`summarize-spec.cjs` for input specs, `summarize-manifest.cjs` for saved post-deploy wrappers), readiness evaluation with concrete thresholds (`evaluate-readiness.cjs`), `deploy_app`-response classification (`classify-deploy-response.cjs`), `deploy_app`-error classification for partial-success (`classify-deploy-error.cjs`), URL extraction from typed connection payloads (`format-success.cjs`), `DeploymentPlan` block rendering (`render-deployment-plan.cjs`), enum decoding (`decode-lease-state.cjs`), troubleshoot report rendering (`render-troubleshoot-report.cjs`), redacted summarization (`summarize-manifest.cjs`, `list-saved-manifests.cjs`), FQDN format validation (`validate-domain.cjs`), DNS resolution probes with hard timeouts (`dns-precheck.cjs`).

**In prose:** asking the user open-ended questions (image refs, env values, service names), interpreting fuzzy diagnostic signals (the `troubleshoot-deployment` suggestion table), branching on unstable response shapes that require LLM judgment.

The motivation: deterministic logic in prose accumulates LLM-paraphrasing drift across runs and can silently regress when models change. Scripts pin the contract.

The enumeration above is illustrative; see "Scripts inventory" below for the full per-script catalog.

## Scripts inventory

Every file under `scripts/`. Underscore-prefixed files are sibling-only modules consumed via `require('./_X.cjs')` — skills MUST NOT shell out to them. Non-underscore files are normally CLI entry points invoked by skills (or by other scripts via `spawnSync`); two non-underscore non-CLI modules exist as a documented exception (`humanize-denom.cjs` and `summarize-app-status.cjs` — see "Renderer / structural summarizers" below). Most CLI scripts emit a single line of JSON on stdout; renderer scripts emit Markdown blocks. CLI scripts exit `1` on argv/usage errors and write a one-line diagnostic to stderr; scripts that classify or probe (e.g. `dns-precheck.cjs`, `classify-deploy-error.cjs`) treat the "failed" classification as a normal stdout result and exit `0`.

Use `grep -rn '<script>.cjs' skills/ scripts/ references/` if you need to locate callers — the call graph drifts and isn't worth restating in prose.

### CLI entry points

- **`build-set-domain-args.cjs`** — Builds the positional args array for `set-item-custom-domain` broadcasts. Flags: `--lease-uuid`, `--fqdn`, `--clear`, `--service-name`.
- **`classify-deploy-error.cjs`** — Classifies `deploy_app` MCP throw-path envelopes into `partially_succeeded` vs `failed`, extracts `lease_uuid` for partial-success recovery. Flags: `--expected-custom-domain`. Reads error envelope from stdin.
- **`classify-deploy-response.cjs`** — Classifies `deploy_app` return values into `active` / `needs_wait` / `failed` based on connection presence and lease state. Reads response from stdin.
- **`decode-lease-state.cjs`** — Decodes a Cosmos `LeaseState` integer or string to canonical name (`LEASE_STATE_ACTIVE`, `LEASE_STATE_PENDING`, etc.). Flags: `--state`, `--json`.
- **`dispatch-deploy-input.cjs`** — Classifies the `/deploy-app` argument string into a mode (`empty`, `spec_file`, `single_image`, `multi_image`, `error`). Flags: `--arguments`.
- **`dns-precheck.cjs`** — Warn-only DNS A/AAAA/CNAME probe with hard 5 s timeout. Flags: `--domain`, `--timeout-ms`. Used at FQDN-management time only — at deploy time the provider FQDN doesn't exist yet.
- **`evaluate-readiness.cjs`** — Evaluates `check_deployment_readiness` response for `ok` / `warn` / `block` and explains which threshold tripped. Flags: `--gas-price`, `--gas-warn-floor`, `--chain-data-file`. Reads readiness response from stdin.
- **`extract-lease-items.cjs`** — Extracts a specific lease's items array from `leases_by_tenant` response. Flags: `--lease-uuid`. Reads response from stdin.
- **`extract-primary-image.cjs`** — Extracts the canonical image reference from a spec (first service's image for stacks, top-level for singles). Reads spec from stdin.
- **`fetch-chain-registry.cjs`** — Fetches Manifest mainnet + testnet chain data from the Cosmos chain registry, injects the testnet `faucetUrl`, writes to `$MANIFEST_PLUGIN_DATA/chains/`. Flags: `--data-dir`.
- **`format-success.cjs`** — Renders the user-facing "Deployed." block (URL, lease UUID, provider) from a `deploy_app` response. Flags: `--lease-uuid`. Reads response from stdin.
- **`gen-agent-key.cjs`** — Non-interactive Cosmos keypair generation. Generates a random 32-byte password internally; emits `{ address, keyfile, password, agentId }` JSON on stdout (the orchestrator then pipes that into `write-config.cjs`). Flags: `--prefix`, `--output`.
- **`humanize-fee.cjs`** — Renders a `cosmos_estimate_fee` result as a human-readable string (e.g. `0.0023 MFX`). Flags: `--chain-data-file`, `--fee-json`.
- **`import-key.cjs`** — Non-interactive mnemonic import. Reads mnemonic from stdin (one line, space-separated). Generates a random 32-byte password internally; emits `{ address, keyfile, password, agentId }` JSON on stdout. Flags: `--prefix`, `--output`.
- **`inspect-image.cjs`** — Inspects an OCI image via the Distribution API (extracts ports, env defaults, digest). Flags: `--image`.
- **`journal-read.cjs`** — Read-only query over the operation journal. Flags: `--date`, `--since`/`--until` (inclusive range), `--skill`, `--lease`, `--outcome`, `--signer`, `--format markdown|jsonl` (default markdown), `--limit`. Tolerates a torn final line silently (power-loss safety); earlier unparseable lines log to stderr but don't abort. Default scope is today UTC.
- **`journal-write.cjs`** — Append a JSON record (read on stdin) to today's `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` (UTC). Auto-fills `timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` (from `$MANIFEST_SESSION_ID`) when absent. Fail-closed: refuses (exit 1) when any key matches `_journal.SECRET_KEY_DENYLIST` (canonical list lives in `scripts/_journal.cjs`; covers `mnemonic`, `password`, `private_key`, `secret_key`, `api_key`, `auth_token`, `bearer_token` variants). Flag: `--dry-run`.
- **`list-saved-manifests.cjs`** — Lists saved post-deploy wrappers with redacted non-sensitive fields (never `manifest_json`).
- **`merge-env.cjs`** — Reads dotenv-format from stdin and merges it into `spec.services[<name>].env` (or top-level `spec.env`) in place. Outputs only the merged keys, never values. Flags: `--spec-file`, `--service-name`.
- **`remove-manifest.cjs`** — Unlinks a saved wrapper after `close_lease`. No-op if missing. Flags: `--lease-uuid`.
- **`render-balance.cjs`** — Renders a `credit_balance` MCP response as a fixed-shape four-line Markdown block (wallet, credit balance, burn rate + running-app count, runway hours). Required flags: `--chain-data-file`, `--address`. Reads response from stdin. Internally requires `humanize-denom.cjs` to format on-chain denoms. Missing optional fields render as `(unavailable)` so the layout stays stable run-to-run.
- **`render-deployment-plan.cjs`** — Renders the canonical `DeploymentPlan` block printed verbatim before broadcasting. Flags: `--meta-hash`, `--image`, `--size`, `--tx-gas`, `--tx-fee` (human-readable string from `humanize-fee.cjs`, NOT raw `<amount><denom>`), `--custom-domain`, `--custom-domain-service`, `--set-domain-tx-gas`, `--set-domain-tx-fee`, `--chain-data-file`. Reads a `{ summary, readiness }` envelope on stdin (summary shape from `summarize-spec.cjs`; readiness shape from `evaluate-readiness.cjs`). Internally requires `humanize-denom.cjs` to format wallet balances. **Single source of truth for plan format** — the runtime policy in `session-start.sh` defers to this script's stdout, so changes here propagate to both the policy and the orchestrator skill.
- **`render-intent-recap.cjs`** — Renders the deterministic structural portion of the deploy intent recap (chain, signer, format, service count). Flags: `--active-chain`. Reads spec from stdin.
- **`render-partial-success-prompt.cjs`** — Renders the AskUserQuestion options for the partial-success recovery branch (retry-set-domain / salvage / cancel). Flags: `--lease-uuid`, `--decoded-state`, `--reason`, `--requested-custom-domain`.
- **`render-providers.cjs`** — Renders a `get_providers` MCP response as a Markdown table (`UUID | Address | API URL | Active`) preserving chain order. Empty list renders as `(no providers registered)`. Reads response from stdin; no flags. `payoutAddress` and `metaHash` are intentionally omitted (not user-actionable).
- **`render-releases.cjs`** — Renders an `app_releases` MCP response as a Markdown table (`Version | Image | Status | Created`) sorted by version descending. Empty list renders as `(no releases yet)`. Reads response from stdin; no flags.
- **`render-troubleshoot-report.cjs`** — Renders the full Markdown troubleshoot report from `app_status` + `app_diagnostics` + `get_logs` responses. Reads payload from stdin.
- **`save-manifest.cjs`** — Persists a v3 wrapper at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` (mode `0600`). Manifest JSON is read from a tmpfile to keep large payloads off the command line. Required flags: `--lease-uuid`, `--image`, `--size`, `--meta-hash`, `--chain-id`, `--manifest-file`. Optional: `--custom-domain`, `--custom-domain-service-name`.
- **`save-manifest-draft.cjs`** — Atomic-writes a deployment spec to a user-managed draft path. Refuses to overwrite. Flags: `--path`. Reads spec from stdin.
- **`summarize-manifest.cjs`** — Renders the redacted (env keys, never values) summary of a saved post-deploy wrapper. Flags: `--lease-uuid`.
- **`summarize-spec.cjs`** — Reads a spec from stdin, emits structural summary (format, service count, env *keys* only, image refs). Used in intent recaps and as the `summary` half of `render-deployment-plan.cjs`'s stdin envelope.
- **`synthesize-deploy-response.cjs`** — Synthesizes a `DEPLOY_RESPONSE`-shaped object from `app_status` for the fallback path where `deploy_app` returned without an active connection. Flags: `--lease-uuid`, `--custom-domain`.
- **`update-config.cjs`** — Mutates `$MANIFEST_PLUGIN_DATA/config.json` in place (chain switch, gas price/multiplier change, registry refresh, status snapshot). Flags: `--status`, `--chain`, `--gas-price`, `--gas-token`, `--gas-multiplier`, `--refresh-chains`. `--status` is read-only and mutually exclusive with the mutating flags.
- **`validate-domain.cjs`** — Loose client-side FQDN sanity check (length ≤ 253, lowercase, ≥1 dot, no leading/trailing dots/hyphens, non-numeric TLD). Flags: `--domain`. Authoritative validation is on-chain.
- **`verify-domain-state.cjs`** — Re-queries `leases_by_tenant` post-broadcast and asserts the lease item's `customDomain` matches expected. Flags: `--lease-uuid`, `--service-name`, `--expected`.
- **`write-config.cjs`** — Writes a fresh `config.json` from key-script output + chain selection (used during init/import flows where there's no existing config to update). Flags: `--chain`, `--gas-price`, `--gas-token`.
- **`start-server.cjs`** — MCP wrapper. Reads `config.json`, builds env vars (see "config.json → MCP env var mapping"), spawns `$MANIFEST_PLUGIN_DATA/node_modules/.bin/manifest-mcp-<name>` directly. Forwards SIGTERM/SIGINT/SIGHUP. Uses `stdio: 'inherit'` so MCP JSON-RPC passes through transparently. Argv: `<name>` (one of `chain` / `lease` / `fred` / `cosmwasm`). Wired up via `.mcp.json`.

### Renderers not invoked by skills (documented exceptions to the underscore-prefix rule)

These are conceptually renderers that other renderers compose, so they live without an `_` prefix — but skills don't shell out to them as part of any orchestration flow. (`summarize-app-status.cjs` does carry a `#!/usr/bin/env node` shebang and a `require.main === module` block for ad-hoc debugging; it's intentionally not part of any skill's surface.)

- **`humanize-denom.cjs`** — Converts on-chain denoms to human-readable symbols via the chain registry. Exports `loadChainDenomMap`, `humanizeCoin`, `humanizeBalances`, `denomToSymbol`. Pure module — no CLI entry.
- **`summarize-app-status.cjs`** — Renders the "Status" section of the troubleshoot report. Exports `renderStatusSection`. Has an ad-hoc CLI (reads JSON from stdin, prints the section) but no skill invokes it; the production caller is `render-troubleshoot-report.cjs` via `require()`.

### Internal helpers (`_<topic>.cjs`)

- **`_connection.cjs`** — Decodes provider `connection` payloads into running-instance ingress data. Exports `extractRunningEndpoints`, `formatEndpointAsUrl`, `formatEndpointAsIngress`, `hasRunningInstances`.
- **`_gas-price.cjs`** — Composes a Cosmos gas-price string (`<amount><denom>`) by symbol lookup in chain registry data. Exports `composeGasPrice`.
- **`_https-json.cjs`** — Shared HTTPS GET helper with SSRF guard (via `request-filtering-agent`), 15 s timeout, 5 MB body cap. Exports `httpsGet`.
- **`_io.cjs`** — Shared I/O primitives. Exports `getDataDir` (resolves `$MANIFEST_PLUGIN_DATA`, errors if missing), `atomicWrite` (write-tmp-then-rename with mode preservation), `readJsonFile`.
- **`_journal.cjs`** — Operation-journal helpers. Exports `SCHEMA_VERSION` (1), `MAX_RECORD_BYTES` (4096 — target single-`write(2)` size that Linux ext4/xfs serialize via the inode mutex; best-effort, not a POSIX guarantee — see the helper's header for the full concurrency model), `SECRET_KEY_DENYLIST` (canonical regex covering `mnemonic`, `password`, `private_key`, `secret_key`, `api_key`, `auth_token`, `bearer_token` variants), `SUSPECT_KEY_PATTERN` (broader pattern used in args-redacted walks), `appendRecord(record)` (validates + appends; oversized records replaced with a `journal_truncated` marker), `redactArgs(toolName, rawArgs)` (per-tool reduction — spec → summary for `deploy_app`/`build_manifest_preview`, manifest → summary for `update_app`, verbatim CLI args for `cosmos_tx`/`cosmos_estimate_fee`, deep-walk for other known-safe tools, defensive walk for unknown tools; non-object rawArgs route through the unknown-tool fallback), `validateRecord(record)` (fail-closed: throws if any key in the tree matches `SECRET_KEY_DENYLIST`, also rejects non-object roots including arrays), `todayUtcDate`, `journalDir`, `journalFilePath`. Used by `journal-write.cjs`/`journal-read.cjs` and any future sibling that needs to write directly without shelling out.
- **`_lease-items.cjs`** — Shape decoders for lease responses. Exports `pickLeasesArray`, `normalizeItem`, `findLease`.
- **`_lease-state.cjs`** — Canonical `LeaseState` enum table + decode/isTerminal helpers. Exports `STATES`, `TERMINAL_STATES`, `decode`, `isTerminal`.
- **`_spec.cjs`** — Spec inspection (single-service vs services-map detection, normalization). Exports `isStack`, `firstImage`, `normalizeServices`.
- **`_uuid.cjs`** — Strict UUID v4 regex (8-4-4-4-12 lowercase hex). Exports `UUID_RE`, `UUID_PATTERN`, `isUuid`.

### Hook scripts

- **`session-start.sh`** — SessionStart hook. (1) Captures the hook payload from stdin so step (3) can extract `session_id`. (2) Emits the runtime transaction policy heredoc on stdout (canonical source of the runtime-facing policy; CLAUDE.md is dev-only). (3) Exports `MANIFEST_PLUGIN_ROOT`, `MANIFEST_PLUGIN_DATA`, `NODE_PATH` via `CLAUDE_ENV_FILE`, and `MANIFEST_SESSION_ID` when the hook payload's `session_id` field is parseable (jq if available, grep+sed fallback otherwise; absent → field omitted, journal records carry `session_id: null`). (4) Bootstraps `npm install --omit=dev` when `package.json` differs between plugin root and `$MANIFEST_PLUGIN_DATA`. Failure log at `$MANIFEST_PLUGIN_DATA/.last-install.log`.
- **`pre-tool-use.sh`** — PreToolUse hook. Emits `{hookSpecificOutput.permissionDecision: "ask"}` for every broadcast tool in the matcher (see "Tools gated by the PreToolUse hook" below). Fail-closed: any error in the trap emits `deny` instead. Cannot verify the agent showed a fee summary first — that's the runtime policy's job.

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
- `mcp__manifest-lease__set_item_custom_domain`

Read-only tools and the testnet faucet (`mcp__manifest-chain__request_faucet`) are intentionally not gated.

**Upstream caveat — bypass permissions mode**: The PreToolUse hook returns `permissionDecision: "ask"`, which hits a known Claude Code bug ([anthropics/claude-code#37420](https://github.com/anthropics/claude-code/issues/37420)) where bypass permissions mode is permanently reset after the first hook-triggered prompt. Users running with `--dangerously-skip-permissions` will see the first broadcast prompt correctly, then lose bypass for the rest of the session. This is documented as a known trade-off in `README.md` under "Security → Known trade-offs" and is considered acceptable for this plugin's use case. If the upstream bug is fixed, no code change is needed here — just update the README. Do not try to work around it by switching to `exit 2` or log-only patterns: both defeat the confirmation guarantee.

## Testing Changes

Quick smoke run:

```bash
# Test the plugin locally (SessionStart hook handles npm install + env export)
claude --plugin-dir .

# Run the unit tests (no MANIFEST_PLUGIN_DATA needed — tests stub it)
npm test
```

For exercising scripts directly without Claude Code, fixture setup, and the per-script test conventions, see [`docs/testing.md`](docs/testing.md).

## Manifest specs (user-managed)

Deployment specs are plain JSON files in the same shape `mcp__manifest-fred__build_manifest_preview` and `mcp__manifest-fred__deploy_app` accept:

- Single-service: `{ image, port, env?, labels?, command?, args?, health_check?, storage?, tmpfs?, init? }`
- Multi-service: `{ services: { <name>: { image, ports, env?, ... }, ... }, storage?, depends_on? }`

`/manifest-agent:author-manifest` walks the user through building one and saves it (default `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json`, or any user-chosen absolute path inside the drafts dir or the system tmpdir). Spec files are user-managed: hand-edit them in `$EDITOR`, version-control them in your app repo, generate them with a script, etc. The plugin doesn't garbage-collect drafts.

`/manifest-agent:deploy-app <path>` consumes a spec file. `/manifest-agent:deploy-app` with no argument drives the inline authoring sequence and deploys in one shot (no draft file written).

Helper: `scripts/save-manifest-draft.cjs` (atomic write + `0600`, refuses to overwrite). Skills should NOT write spec files via `Write` directly — it bypasses the safety checks.

### Sensitive env values (file-pipe pattern)

Mirrors the mnemonic-import pattern used by `init-agent` / `import-key`. The user creates a dotenv file in a separate terminal (`cat > /tmp/<svc>.env` … Ctrl+D, then `chmod 600`), names the path in chat, and the agent pipes it through `scripts/merge-env.cjs` to mutate the spec file in place. The script outputs only the merged keys (never values), so the chat input box stays clean and the agent never echoes secrets in summaries. Author flow merges into the saved spec at `--spec-file <SAVED_PATH>`; deploy flow materializes the in-memory spec to a `/tmp/.spec-env-<pid>.json`, merges, then `Read`s it back.

What this protects: the chat input never carries secrets, and prose summaries (intent recap, deployment plan) are keys-only by construction (`scripts/summarize-manifest.cjs`, `scripts/summarize-spec.cjs`).

What it doesn't: env values still flow into the `build_manifest_preview` and `deploy_app` MCP tool call args at validation + broadcast time, which means they enter the agent's API context for those turns. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Custom domains

`manifest-mcp-node@0.8.0` added FQDN support to the lease layer. Three integration points in this plugin:

**Spec-file shape (camelCase, mirrors deploy_app input):** top-level `customDomain?: string` and `serviceName?: string`. `serviceName` is required when `customDomain` is set on a stack and must match a key in the `services` map; for single-service specs it's omitted (the only item is the implicit target). Spec uses camelCase so the agent can splat the spec into the `deploy_app` MCP call without renaming.

**Wrapper-file shape (snake_case, mirrors v2 + chain `service_name`):** `custom_domain?: string` and `custom_domain_service_name?: string` added at `schema_version: 3`. v2 wrappers remain readable; missing v3 fields render as undefined.

**Naming asymmetry rationale:** spec → camelCase (deploy_app input contract); wrapper → snake_case (existing v2 + chain response convention); intent recap / DeploymentPlan / format-success → human prose. Each layer mirrors its source-of-truth.

**Dual-tx broadcast on `deploy_app`:** when `customDomain` is set, `deploy_app` broadcasts TWO billing txes atomically — `create-lease` first, then `set-item-custom-domain` — both inside one MCP tool call. The PreToolUse permission prompt fires once and covers both. The DeploymentPlan + intent recap MUST itemize both fees (line-by-line, with `Total fee:`) so the per-tx review is in the textual flow.

**`set-item-custom-domain` pre-broadcast fee estimation:** the chain keeper validates lease existence + ownership against the simulated msg sender, so simulating against a non-owned placeholder UUID fails. Use a representative existing ACTIVE lease owned by the signer (query `leases_by_tenant` and pick the first ACTIVE entry); the fee transfers cleanly because it's essentially fixed for this msg type. If no representative lease exists (fresh wallet), the orchestrator renders `Tx fee (set-domain): (not estimated — no representative lease available)` per the approved approach-3 fallback; the recap surfaces the gap explicitly.

**Partial-success failure mode:** the upstream `deploy_app` pipeline runs `create-lease` → `set-item-custom-domain` → manifest upload → readiness poll. If anything after `create-lease` fails (most commonly: a set-domain failure, which means the manifest is NEVER uploaded), `deploy_app` THROWS a `ManifestMCPError` with message starting `Deploy partially succeeded: lease ${uuid} was created…` and `details.lease_uuid` populated — there is NO returned `deploy_response` in this case. The orchestrator routes the thrown envelope through `scripts/classify-deploy-error.cjs` (separate from `classify-deploy-response.cjs`, which only handles the return path), which extracts the lease UUID and outputs `outcome: "partially_succeeded"`. The deploy-app skill's Step 11 then queries `app_status` to decode the lease state and offers state-aware recovery: **Retry set-domain + upload** (re-attach the domain via `set_item_custom_domain` then upload the manifest via `update_app`), **Salvage without domain** (skip the domain entirely; just upload the manifest via `update_app` so the lease starts serving on the provider FQDN), or **Cancel/Close** the lease. Cleanup uses the right primitive for the lease state — `LEASE_STATE_PENDING` requires `billing cancel-lease` (via `cosmos_tx`; no MCP wrapper today), `LEASE_STATE_ACTIVE` uses `close_lease`.

**Standalone management:** `/manifest-agent:manage-domain` skill handles set / clear / lookup on existing leases. `set` and `clear` go through the same `cosmos_estimate_fee` → textual confirm → PreToolUse → on-chain verification pattern as `close-lease` (mirrors `troubleshoot-deployment` Step 6). `lookup` uses `lease_by_custom_domain` for reverse FQDN → lease resolution; read-only, ungated.

**Where the new tools live:** `set_item_custom_domain` and `lease_by_custom_domain` are in `manifest-mcp-lease` (NOT `manifest-fred`); the PreToolUse matcher uses the `mcp__manifest-lease__…` form.

**DNS pre-check (warn-only, manage-domain only):** `scripts/dns-precheck.cjs` issues `resolve4`/`resolve6`/`resolveCname` concurrently with a hard `Promise.race` 5 s timeout (libuv's getaddrinfo otherwise hangs ~10 s × 2 attempts × 3 lookups = up to 30 s). Outputs `{ resolved, a, aaaa, cname?, reason? }`. The pre-check is invoked ONLY by `/manifest-agent:manage-domain` (where the lease already exists, the user knows the provider FQDN to CNAME against, and pre-flight DNS state is meaningful). The deploy-app skill does NOT pre-check DNS — at deploy time the user can't have set DNS yet because the provider's ingress FQDN is only assigned after `deploy_app` succeeds. The chain is the authoritative arbiter of FQDN format and reservation; DNS resolution affects only browser routing, not the chain claim.

**FQDN client-side validation:** `scripts/validate-domain.cjs` enforces length ≤ 253, lowercase, ≥1 dot, no leading/trailing dots/hyphens, non-numeric TLD. Catches obvious typos before broadcasting. Authoritative validation is on-chain.

**Custom domains in saved manifests:** the v3 wrapper persists `custom_domain` + `custom_domain_service_name` when `deploy_app`'s response carried them. `summarize-manifest.cjs` and `list-saved-manifests.cjs` surface them safely (FQDNs are not secrets). `troubleshoot-deployment` Step 1 picker also adds a "lookup by custom domain" option using `lease_by_custom_domain`, and Step 4's saved-manifest section shows `Custom domain:` / `Domain service:` lines when present. **Known limitation:** `manage-domain` set/clear operations do NOT refresh the saved wrapper's `custom_domain` field — `save-manifest.cjs` requires the canonical `manifest_json` bytes (for SHA-256 audit) which `manage-domain` never has, and re-reading the wrapper to recover them would defeat the secrets-handling discipline. The wrapper's `custom_domain` may go stale until the next `deploy-app` run for that lease; consumers needing the live value should query the chain via `leases_by_tenant` or `lease_by_custom_domain`.

## Saved post-deploy records

After a successful broadcast `/manifest-agent:deploy-app` persists a wrapper at `$MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json` (mode `0600`, parent dir `0700`). Wrapper schema v3: `{ schema_version: 3, lease_uuid, deployed_at_iso, deployed_at_unix, chain_id, image, size, meta_hash_hex, format, manifest_json, custom_domain?, custom_domain_service_name? }` where `manifest_json` is the canonical Fred-rendered string (preserves the exact bytes whose SHA-256 is `meta_hash_hex` for audit), `format` is `"single"` or `"stack"`, and the optional v3 fields capture any custom-domain attached at deploy time. v2 wrappers remain readable; the new v3 fields are treated as undefined when absent. The wrapper itself carries no credentials, but `manifest_json` includes the env values the user supplied during authoring — those can be sensitive (DB URLs, API tokens). Exposure is mitigated by file permissions; skills must NOT pretty-print `manifest_json` into chat unredacted.

Skills MUST use the wrapper helpers (`save-manifest.cjs`, `remove-manifest.cjs`, `list-saved-manifests.cjs`, `summarize-manifest.cjs`) instead of `Read`-ing or `Write`-ing the wrapper file directly — the helpers enforce atomic write, mode `0600`, and redaction discipline. See the Scripts inventory above for each helper's flag surface.

Naturally-expired leases leave their saved manifest in place — the file is the historical record. There is no periodic sweep. Lease lifecycle (active / closed / expired) is queried fresh from chain state via `app_status` rather than tracked in the wrapper.

### Wrapper schema evolution

When changing the wrapper shape, bump `schema_version` and update both writers and readers in lockstep:

- **Writer**: `save-manifest.cjs` produces only the current version.
- **Readers**: `summarize-manifest.cjs`, `list-saved-manifests.cjs`, and any skill prose that names a field. Readers MUST treat unknown-newer wrappers as readable to the extent of their known fields, and missing optional fields as `undefined` (no defaulting). The v2→v3 transition (custom-domain fields) is the worked example — v2 wrappers still load via the same readers, with `custom_domain`/`custom_domain_service_name` rendering as undefined.
- **Tests**: `tests/summarize-manifest.test.cjs` is the canonical place to add a fixture asserting the new shape AND a v(N-1) fixture asserting backward read compatibility.

There is no migration step — the wrapper is a record, not a config file. A v2 wrapper stays v2 on disk forever; v3 wrappers are written for new deploys only.

## Operation journal

Every state-changing skill appends one record per invocation to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` (UTC, mode `0600`, parent dir `0700`). Records capture intent, plan summary, tool calls (`args_redacted` per `_journal.cjs#redactArgs`), outcome, errors, recovery actions, and final state. Schema docstring lives at the top of `_journal.cjs`. The skill `/manifest-agent:journal` is the canonical reader.

**Writing**: skills pipe a JSON record to `journal-write.cjs`. The writer auto-fills `timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` (from `$MANIFEST_SESSION_ID`); runs `validateRecord` (fail-closed against `SECRET_KEY_DENYLIST` — see below); appends one line via `fs.appendFileSync(... { flag: 'a' })`. Concurrency story: on Linux ext4 / xfs the inode mutex serializes concurrent `write(2)` calls to a regular file, so a record under `MAX_RECORD_BYTES` (4 KiB) appends without interleaving in practice — best-effort, not a POSIX guarantee (`PIPE_BUF` formally applies to pipes / FIFOs only). Records exceeding 4 KiB are replaced with a smaller `journal_truncated` marker so realistic concurrent writes stay in the single-`write(2)` regime and the daily file never carries a torn line.

**Redaction discipline** — same posture as `summarize-manifest.cjs`:
- Env maps render as sorted keys, never values.
- The writer is fail-closed (NOT strip-and-continue): any key in the record tree matching `_journal.SECRET_KEY_DENYLIST` (`mnemonic`, `password`, `private_key`, `secret_key`, `api_key`, `auth_token`, `bearer_token`, all with optional `_`/`-` separators) makes `journal-write.cjs` exit 1 and refuse to append. Skills must redact via `_journal.redactArgs` before piping.
- `manifest_json` is reduced via the in-process equivalent of `summarize-spec.cjs`, never embedded raw.
- Lease UUIDs, addresses, image refs, custom domains, gas-token symbols ARE captured (legitimate non-sensitive blockchain identifiers).

**Skills that DON'T write a record**: `manage-domain` lookup sub-flow (read-only), `troubleshoot-deployment` when `close_lease` doesn't fire (read-only). The `/manifest-agent:journal` query skill is also read-only and writes nothing.

**Failure-path records**: `deploy-app` writes a record at every terminal point — Step 10 success, Step 11 partial-success, Step 11 has-lease failure, Step 11 no-lease failure. Cancelled flows (user declined at any confirm gate) get a record with `outcome: "cancelled"` and a small `final_state.cancelled_at`.

**Schema versioning**: bump `_journal.cjs#SCHEMA_VERSION` when the record shape changes. Readers (`journal-read.cjs`) treat unknown-newer schema versions as opaque records — they're surfaced verbatim in JSONL mode and rendered with whatever fields they happen to carry in markdown mode. There is no migration; old records stay on disk in their original schema forever.

**Out of scope by design**: encryption at rest (mode `0600` + parent `0700` is the same posture as saved manifest wrappers), vector store / embeddings / retrieval (JSONL is the substrate; indexing layers slot on top later without changing the writer), cross-host sync (the journal is per-machine).

## Fred manifest schema

`build_manifest_preview` (in `manifest-mcp-fred`) bakes the Fred manifest JSON Schema into the package. If Fred revs the schema, this plugin must bump `manifest-mcp-node` to pick it up. The `refresh-registry` skill only refreshes Cosmos chain-registry data; it does not update the bundled Fred schema.

## Chain Data

Fetched from the Cosmos chain registry (`cosmos/chain-registry` on GitHub):
- Mainnet: `manifest/chain.json` — chain ID `manifest-ledger-mainnet`, RPC at `nodes.liftedinit.app`
- Testnet: `testnets/manifesttestnet/chain.json` — chain ID `manifest-ledger-testnet`, RPC at `nodes.liftedinit.tech`
- Gas: both `umfx` and factory `upwr` token are valid fee tokens. The plugin extracts `fees.fee_tokens[0]` (umfx) by default. If the chain registry's ordering ever changes, the default flips silently — pin the choice via `update-config.cjs --gas-token` if you need stability.
- Faucet: testnet only. The chain registry does not advertise it, so `fetch-chain-registry.cjs` injects `https://faucet.testnet.manifest.network/` directly into the testnet chain data. See the env-var table above for how it propagates.

## For contributors

Workflow docs live in [`docs/`](docs/):

- [`docs/testing.md`](docs/testing.md) — running tests, adding tests, fixture conventions, exercising scripts outside Claude Code.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch naming, commit conventions, PR checklist.
- [`docs/release.md`](docs/release.md) — version-bump flow and tagging.

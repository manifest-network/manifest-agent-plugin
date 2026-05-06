# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin (`manifest-agent`) that bootstraps an autonomous agent for the Manifest blockchain. It installs MCP tooling, manages keypairs, fetches chain registry data, and configures everything so the agent can interact with testnet or mainnet.

## Architecture

**Plugin root is read-only in production.** Marketplace installs copy the plugin to `~/.claude/plugins/cache/`. All mutable state lives in `${CLAUDE_PLUGIN_DATA}` — Claude Code's persistent per-plugin data directory, resolved at runtime to `~/.claude/plugins/data/<id>/` and exposed to scripts as `$MANIFEST_PLUGIN_DATA` (exported by the SessionStart hook).

```
Plugin root (read-only)          Runtime data ($MANIFEST_PLUGIN_DATA)
├── scripts/*.cjs                ├── config.json        (0600, has key password)
├── skills/*/SKILL.md            ├── keys/agent-*.json  (0600, encrypted wallets)
├── hooks/hooks.json             ├── chains/{mainnet,testnet}.json
├── .mcp.json                    ├── node_modules/      (deps installed here)
└── package.json                 └── package.json       (copied from plugin root)
```

**Data flow**: Skills run scripts → scripts write to `$MANIFEST_PLUGIN_DATA` → MCP wrapper reads `config.json` at startup → spawns MCP binary with computed env vars.

**Dependency resolution**: All scripts are CJS (`.cjs`) because NODE_PATH only works with CommonJS, not ESM. The SessionStart hook exports `NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules` once via `CLAUDE_ENV_FILE`, so every `node` invocation in skill bash blocks (and ad-hoc dev usage) inherits it without per-site prefixing.

**Plugin root + data discovery**: The SessionStart hook exports `MANIFEST_PLUGIN_ROOT` and `MANIFEST_PLUGIN_DATA` via `CLAUDE_ENV_FILE`, mirroring Claude Code's `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` substitutions (which only expand inside `.mcp.json`, hooks, etc., not in scripts). Skills use `$MANIFEST_PLUGIN_ROOT` to locate scripts and `$MANIFEST_PLUGIN_DATA` for runtime files. Scripts read `process.env.MANIFEST_PLUGIN_DATA` (the `_io.cjs` `getDataDir()` helper centralizes the lookup + missing-var error).

**Dependency bootstrap**: The SessionStart hook also runs the docs' diff-check + `npm install` pattern automatically when `package.json` differs between plugin root and `${CLAUDE_PLUGIN_DATA}`. First-run users don't need to call `init-agent` to get a working MCP wrapper.

## Key Patterns

**All scripts use CJS** — `require()`, async IIFE with `.catch(() => process.exit(1))`. Use `getDataDir()` from `_io.cjs` for the data directory path; never compose `homedir() + '.manifest-agent'` (the latter is the legacy pre-v0.5 path).

**Secrets via stdin** — Mnemonics are piped via heredoc (`<<'EOF'`, single-quoted to prevent shell expansion), never as command-line args (visible in `/proc/*/cmdline`).

**Underscore-prefix helpers** — Scripts named `_<topic>.cjs` (`_io.cjs`, `_uuid.cjs`, `_gas-price.cjs`, `_connection.cjs`, `_lease-state.cjs`) are sibling-only modules consumed via `require('./_X.cjs')`. Skills MUST NOT shell out to them.

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

```bash
# Test the plugin locally (SessionStart hook handles npm install + env export)
claude --plugin-dir .

# Test scripts independently — set MANIFEST_PLUGIN_DATA manually since
# SessionStart only fires inside Claude Code. Pick any directory you can write
# to; the helper just needs a path and the dir is auto-created on first use.
export MANIFEST_PLUGIN_DATA="$HOME/.manifest-agent-dev"

# Install deps into that dir
mkdir -p "$MANIFEST_PLUGIN_DATA" && cp package.json "$MANIFEST_PLUGIN_DATA/"
npm install --omit=dev --prefix "$MANIFEST_PLUGIN_DATA"

# Test fetch-chain-registry
node scripts/fetch-chain-registry.cjs

# Test key generation
NODE_PATH="$MANIFEST_PLUGIN_DATA/node_modules" node scripts/gen-agent-key.cjs --prefix manifest

# Test MCP wrapper (requires config.json + deps)
node scripts/start-server.cjs chain
```

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

Helpers (skills should use these instead of reading the wrapper file directly):

- `scripts/save-manifest.cjs` — writes the wrapper. Manifest JSON is read from a tmpfile (`--manifest-file`) to keep large JSON off the command line. Atomic write.
- `scripts/remove-manifest.cjs` — unlinks the file. Called by `/manifest-agent:deploy-app` and `troubleshoot-deployment` after a successful `close_lease`. No-op if the file is missing (close_lease may target a lease the agent never deployed).
- `scripts/list-saved-manifests.cjs` — returns the safe-fields-only listing (never `manifest_json`). Used by `troubleshoot-deployment` as a fallback lease picker.
- `scripts/summarize-manifest.cjs` — redacted structural summary (counts + env *keys*, never values). Used by `troubleshoot-deployment`'s "Saved manifest" appendix.
- `scripts/merge-env.cjs` — merges dotenv-format stdin into `spec.services[<name>].env` (or flat `spec.env`) in place. Outputs `keys_merged` only. See "Sensitive env values" above.

Naturally-expired leases leave their saved manifest in place — the file is the historical record. There is no periodic sweep. Lease lifecycle (active / closed / expired) is queried fresh from chain state via `app_status` rather than tracked in the wrapper.

## Fred manifest schema

`build_manifest_preview` (in `manifest-mcp-fred`) bakes the Fred manifest JSON Schema into the package. If Fred revs the schema, this plugin must bump `manifest-mcp-node` to pick it up. The `refresh-registry` skill only refreshes Cosmos chain-registry data; it does not update the bundled Fred schema.

## Chain Data

Fetched from the Cosmos chain registry (`cosmos/chain-registry` on GitHub):
- Mainnet: `manifest/chain.json` — chain ID `manifest-ledger-mainnet`, RPC at `nodes.liftedinit.app`
- Testnet: `testnets/manifesttestnet/chain.json` — chain ID `manifest-ledger-testnet`, RPC at `nodes.liftedinit.tech`
- Gas: both `umfx` and factory `upwr` token are valid fee tokens. The plugin extracts `fees.fee_tokens[0]` (umfx) by default.
- Faucet: testnet only. The chain registry does not advertise it, so `fetch-chain-registry.cjs` injects `https://faucet.testnet.manifest.network/` directly into the testnet chain data. See the env-var table above for how it propagates.

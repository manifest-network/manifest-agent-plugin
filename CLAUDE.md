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

**Underscore-prefix helpers** — Scripts named `_<topic>.cjs` (`_io.cjs`, `_uuid.cjs`, `_gas-price.cjs`, `_spec.cjs`, `_https-json.cjs`, `_journal.cjs`) are sibling-only modules consumed via `require('./_X.cjs')`. Skills MUST NOT shell out to them. The post-ENG-130 `humanize-denom.cjs` is a documented exception because it's conceptually a renderer composed by another renderer (`render-balance.cjs`); see the "Renderer / structural summarizers" subsection of the inventory below.

**MCP wrapper** (`start-server.cjs`) — Reads `config.json`, builds env vars, spawns `$MANIFEST_PLUGIN_DATA/node_modules/.bin/manifest-mcp-<name>` directly (not npx — 30ms vs 800ms startup). Forwards SIGTERM/SIGINT/SIGHUP. Uses `stdio: 'inherit'` so MCP JSON-RPC passes through transparently.

**Falsy env vars** — The wrapper omits optional env vars when falsy rather than setting them to `''`. Empty `MANIFEST_KEY_PASSWORD` causes the MCP server to throw.

## Open question decisions (ENG-130 rewire)

The ENG-130 rewire left five non-obvious decisions documented here so future readers can map skill / script choices back to the rationale:

- **DECISION 1 — `author-manifest` stays plugin-side.** `manifest-mcp-agent` ships no `build_manifest_preview_orchestrated` tool (would have been an upstream ENG-204-tier ticket). The standalone draft-creation flow remains in the plugin over the surviving `save-manifest-draft.cjs` + `merge-env.cjs` helpers. The rewired `deploy-app` skill takes one input (a file path) and points non-file input at `/manifest-agent:author-manifest`; `deploy_app_orchestrated`'s `validateSpec()` requires a complete `DeploySpec` up front, so the rewire converged on author → deploy as two explicit steps rather than the pre-rewire one-shot "deploy with inline author" UX.
- **DECISION 2 — saved-manifest read surface stays; write surface moves.** Deleted: `save-manifest.cjs`, `remove-manifest.cjs` (agent-core's `saveManifest()` owns persistence end-to-end via `MANIFEST_AGENT_DATA_DIR`; cleanup is inside `closeLease`'s recovery dispatch). Kept: `list-saved-manifests.cjs` + `summarize-manifest.cjs` (read-only discovery surface used by the lease-UUID pickers in `manage-domain` Step 2b and `troubleshoot-deployment` Step 1) and `save-manifest-draft.cjs` (for `author-manifest`'s draft creation).
- **DECISION 3 — FQDN validation + DNS pre-check move into agent-core.** Deleted: `validate-domain.cjs`, `dns-precheck.cjs`. agent-core's `manageDomain` runs `validateArgs` (RFC 1123 hostname + scheme rejection + ≤253 char cap) server-side and runs the warn-only DNS probe internally. `build_manifest_preview` validates FQDN format at the spec layer.
- **DECISION 4 — journal mechanism is option-a (skill-side, single-entry-per-orchestrated-call).** The skill prose pipes a record to `journal-write.cjs` with ONE `tool_calls[]` entry per orchestrated invocation. `args_redacted` is produced by `_journal.cjs#redactArgs`'s per-tool reducer (added in ENG-130 for the four new tools). `result_summary` is mined from the orchestrated tool's structured return value. The journal does NOT enumerate inner broadcasts the wrapper dispatches — see "Operation journal" below for the full fidelity-trade-off discussion. `troubleshoot-deployment` is the documented exception: it writes two `tool_calls[]` entries when the cleanup branch fires, because the close call is a separate skill-driven orchestrated tool call after the diagnostic returns (still one entry per orchestrated invocation; the skill just makes two invocations in that branch). The alternative (wrapper-side journal writes) was rejected to keep the plugin's secret-key denylist + record schema out of the upstream package.
- **DECISION 5 — `manage-domain` lookup branches in skill prose.** Set/clear route through `mcp__manifest-agent__manage_domain_orchestrated`; lookup calls `mcp__manifest-lease__lease_by_custom_domain` directly. Rationale: the orchestrated wrapper is broadcast-gated by the PreToolUse hook, which would incorrectly prompt for a chain query. ENG-212 (split lookup into its own MCP tool) is in Backlog and would block ENG-130 if treated as a dependency. The 3-line skill-side branch is the cheapest fix and collapses cleanly when ENG-212 lands.

## Skills

Invoked as `/manifest-agent:<skill-name>`. All skills guard that `$MANIFEST_PLUGIN_ROOT` is set (Step 0).

- **init-agent** — Full setup: install deps, fetch registry, choose chain, generate or import key, write config
- **import-key** — Import existing mnemonic (requires init-agent first)
- **switch-chain** — Switch testnet/mainnet with mainnet confirmation before write
- **set-gas-price** — Change gas fee token, price, and/or gas multiplier
- **refresh-registry** — Re-fetch chain data from Cosmos chain registry
- **author-manifest** — Plugin-side draft creation. Builds + validates a Fred spec via `mcp__manifest-fred__build_manifest_preview`, saves via `save-manifest-draft.cjs` to `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json` (or a user-chosen path). No readiness pre-flight — the orchestrated deploy tool re-checks at broadcast time. No client-side image inspection or domain validation — both moved upstream. See DECISION 1.
- **troubleshoot-deployment** — Picker (`$ARGUMENTS` → `manifest://leases/active` → `list-saved-manifests.cjs` → lookup-by-FQDN → user-paste) plus a thin invocation of `mcp__manifest-agent__troubleshoot_deployment_orchestrated`, which is a pure chain query returning pre-rendered Markdown. The cleanup elicitation, when the user opts in, drives `mcp__manifest-agent__close_lease_orchestrated` as a separate tool call. Both inner broadcasts (`mcp__manifest-lease__close_lease`) still trigger PreToolUse on their own.
- **deploy-app** — Thin invocation of `mcp__manifest-agent__deploy_app_orchestrated` over a complete spec JSON file. `/manifest-agent:deploy-app <path>` is the only input mode — the orchestrated tool requires a fully-formed `DeploySpec` (`validateSpec()` runs first), so non-file input directs the user at `/manifest-agent:author-manifest`. The wrapper owns plan rendering, fee itemization, partial-success recovery, and manifest persistence (via `MANIFEST_AGENT_DATA_DIR`) end-to-end through MCP elicitation. The skill resolves the file, invokes the tool, renders the typed `DeployResult`, and journals the run.
- **manage-domain** — `lookup` calls `mcp__manifest-lease__lease_by_custom_domain` directly (read-only, ungated) so the broadcast permission prompt doesn't fire spuriously. `set` and `clear` route through `mcp__manifest-agent__manage_domain_orchestrated`, which handles fee estimation, textual confirmation (via elicitation), broadcast, and on-chain verification. See DECISION 5; collapses to the orchestrated form when ENG-212 lands.
- **restart-app** — Restart a running app via `restart_app` without closing the lease. Per the `scripts/session-start.sh` runtime policy, `restart_app` is a provider HTTPS call, NOT a Cosmos broadcast — no gas, no fee estimate, no `cosmos_estimate_fee` step. The skill inlines its own textual confirm. PreToolUse still gates the tool. Pre-call: pipe `chainState.state` through `scripts/decode-lease-state.cjs --state "$STATE" --json` and refuse unless the decoded `name` is `LEASE_STATE_ACTIVE`. The helper handles all chain encoding forms (int `2`, stringy-int `"2"`, canonical `"LEASE_STATE_ACTIVE"`) per its companion test (`tests/_lease-state.test.cjs`). Post-call: re-query `app_status` once and pipe the new state through the same decoder; tag the journal `recovery_actions` with `["restart-post-verify-not-active"]` on regression.
- **list-releases** — Read-only call to `app_releases`; renders the version history via `render-releases.cjs` as a Markdown table sorted newest first. True rollback (re-deploying a prior release) is intentionally out of scope — track separately if/when needed.
- **balance** — Read-only call to `credit_balance`; renders wallet balances + credit account state + burn rate + runway hours via `render-balance.cjs` (humanizing denoms via `humanize-denom.cjs`). Optional `$ARGUMENTS` is a bech32 tenant address; default is the agent's own address.
- **list-providers** — Read-only call to `get_providers`; renders the provider table via `render-providers.cjs`. Optional `--all` argument flips `active_only` to false (default surfaces only active providers).
- **journal** — Read-only audit-trail query over `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. Filter by date / skill / lease UUID / outcome / signer. Markdown or JSONL output. The journal is written by every state-changing skill at the end of each invocation; this skill is the canonical reader.

### `references/` files and cross-skill loading

Post-ENG-130 there are no shared references. The plugin-root
`references/{readiness-branching,billing-tx-confirm,verify-recover}.md`
and `skills/deploy-app/references/*.md` files were all deleted because
their content (readiness branching, billing-tx confirm scaffold, post-
broadcast verify-and-recover dispatch, partial-success recovery, post-
failure troubleshoot) moved into `manifest-agent-core` and is now
surfaced through the orchestrated MCP tools. If a future skill needs
to share prose with another, restore the dual-flavor pattern
(skill-local under `skills/<name>/references/`, plugin-root under
`references/`) and re-enumerate consumers in this section.

## Scripts vs prose

This plugin codifies a split between deterministic operations (CJS scripts in `scripts/`) and ambiguous-decision steps (prose in `skills/<name>/SKILL.md`).

**In scripts (plugin-side, surviving post-ENG-130):** UUID validation (`_uuid.cjs`), path traversal guards + atomic write discipline (`_io.cjs`), spec shape detection + service normalization (`_spec.cjs`), gas-price token parsing (`_gas-price.cjs`), SSRF-aware HTTPS fetch (`_https-json.cjs`), the journal layer (`_journal.cjs` + `journal-write.cjs` + `journal-read.cjs`), draft spec write (`save-manifest-draft.cjs`), env-file merge into a saved draft (`merge-env.cjs`), read-only discovery surface (`summarize-manifest.cjs`, `list-saved-manifests.cjs`), denom-aware humanization for read-only renders (`humanize-denom.cjs`), the read-only skill renderers (`render-balance.cjs`, `render-providers.cjs`, `render-releases.cjs`), and setup/auth helpers (`gen-agent-key.cjs`, `import-key.cjs`, `write-config.cjs`, `update-config.cjs`, `fetch-chain-registry.cjs`).

**Now in agent-core (consumed via `manifest-mcp-agent`):** intent recap rendering, `DeploymentPlan` block rendering, readiness evaluation, `deploy_app` response + error classification, partial-success recovery dispatch, URL extraction from typed connection payloads, lease-state enum decoding, troubleshoot report rendering, FQDN format validation, DNS resolution pre-check, generic post-broadcast verify-and-recover dispatch, set-domain CLI arg construction. All of these live inside the four `mcp__manifest-agent__*_orchestrated` tools — the plugin no longer owns them.

**In prose:** asking the user open-ended questions (FQDN strings, env-file paths, service names for stack-lease custom-domain), resolving lease UUID from multiple sources (`$ARGUMENTS` / `manifest://leases/active` / `list-saved-manifests.cjs` / lookup-by-FQDN / paste), branching on the orchestrated tool's typed return value, and writing the journal record.

The motivation: deterministic logic in prose accumulates LLM-paraphrasing drift across runs and can silently regress when models change. Scripts pin the contract — and the orchestrated tools take that discipline a step further, pinning the user-facing wording inside agent-core's `internals/render-*` modules.

> *Hindsight from ENG-130*: when a rewire deletes helpers whose logic moves elsewhere AND inlines residual decode paths into prose on the grounds they're "trivial enums," the survivors are the ones that need the **most** discipline, not the least — they're now the only place the logic lives. If correctness depends on a chain-proto enum value, a wire-encoding detail, or any invariant a future agent-model could paraphrase wrong, it belongs in a tested CJS script.
>
> **Rule of thumb: delete orchestration; keep primitives.** Tier examples — primitives (small, type-narrow, testable invariants — keep): `_io.cjs`, `_uuid.cjs`, `_spec.cjs`, `decode-lease-state.cjs`. Orchestration (multi-step decision flows that LLMs can carry — delete and move into agent-core): `render-deployment-plan.cjs`, `classify-deploy-error.cjs`, `evaluate-readiness.cjs`. The PR #9 Copilot review caught a real instance of this failure mode: an inverted `LEASE_STATE_ACTIVE === 1` in inlined skill prose after the original `_lease-state.cjs` test was deleted. The primitive was restored.

The enumeration above is illustrative; see "Scripts inventory" below for the full per-script catalog.

## Scripts inventory

The per-script catalog (CLI entry points, renderer-exception modules, `_<topic>.cjs` helpers, hook scripts) lives in [`docs/scripts.md`](docs/scripts.md). Read that file when you need to know a specific script's flags, stdin contract, or call site rules. The conventions that apply to the catalog as a whole:

- Underscore-prefixed files are sibling-only modules consumed via `require('./_X.cjs')` — skills MUST NOT shell out to them.
- Non-underscore files are normally CLI entry points; `humanize-denom.cjs` is the post-ENG-130 documented exception (a denom→symbol renderer composed by `render-balance.cjs`).
- CLI scripts exit `1` on argv/usage errors with a one-line stderr diagnostic.
- Use `grep -rn '<script>.cjs' skills/ scripts/` to locate callers — the call graph drifts and isn't worth restating in prose.

## config.json → MCP env var mapping

`start-server.cjs` maps config fields to env vars for the MCP child process. Five servers are registered: `manifest-chain`, `manifest-lease`, `manifest-fred`, `manifest-cosmwasm`, and (post-ENG-130) `manifest-agent`.

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

**Agent-server-only env vars** (set unconditionally when `serverName === 'agent'`, see `start-server.cjs`):

| Computed value | Env var | Required |
|---|---|---|
| `$MANIFEST_PLUGIN_DATA` | `MANIFEST_AGENT_DATA_DIR` | yes (agent-core's `saveManifest()` writes to `<dataDir>/manifests/<lease_uuid>.json` — the same tree the read-only helpers `summarize-manifest.cjs` + `list-saved-manifests.cjs` already index, keeping wrappers cross-readable) |
| `$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json` | `MANIFEST_CHAIN_DATA_FILE` | yes (denom-map humanization for the orchestrated tool's plan + result rendering) |
| `$MANIFEST_AGENT_FETCH_GUARDED` (parent env) | `MANIFEST_AGENT_FETCH_GUARDED` | no (forwarded only when set in parent shell; the agent server defaults to `1` / ON when absent — the SSRF-guarded fetch is on by default) |

## Transaction Behavior (runtime policy)

**Do not edit the policy text in this file.** The canonical, runtime-facing transaction policy lives in `scripts/session-start.sh` as a heredoc and is injected into every Claude session via the SessionStart hook. Plugin CLAUDE.md files are developer docs — they are not loaded into sessions that USE the plugin, so any policy written here never reaches the runtime agent. Edit `scripts/session-start.sh` if you need to change the rules.

Two-layer enforcement:

1. **Runtime policy injection (SessionStart)** — `hooks/hooks.json` → `scripts/session-start.sh` writes the policy text to stdout. Claude Code adds stdout from SessionStart hooks to the session's context, so the rules are present from the first turn. This is how the agent learns to call `cosmos_estimate_fee` first, show the fee, and wait for textual confirmation.
2. **Permission prompt safety net (PreToolUse)** — `hooks/hooks.json` → `scripts/pre-tool-use.sh` emits `{hookSpecificOutput.permissionDecision: "ask"}` for broadcast tools, forcing Claude Code to prompt the user regardless of pre-existing permission settings. Deny beats allow in the hook precedence, and "ask" cannot be loosened by settings.json, so this fires even for pre-approved tools.

Post-ENG-130, the heredoc points at the orchestrated `mcp__manifest-agent__*_orchestrated` tools as the canonical confirmation surface. Plan, fee itemization, and recovery prompts are rendered by `manifest-agent-core`'s internal `internals/render-*` modules (inside the `@manifest-network/manifest-mcp-agent` package) and surfaced via MCP `elicitInput`. To change the user-facing wording, edit those upstream renderers — not the heredoc, not this file.

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

**The four `mcp__manifest-agent__*_orchestrated` wrappers are explicitly NOT gated.** Gating fires on the **inner** broadcast tools the wrappers dispatch (e.g. `deploy_app_orchestrated` calls `mcp__manifest-fred__deploy_app` internally; that inner call hits the matcher and prompts). Adding the orchestrated wrappers to the matcher would cause a double-prompt — once on the wrapper, once on each inner broadcast. CI enforces this via a negative-match assertion in `.github/workflows/ci.yml` so the property can't regress.

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

`/manifest-agent:deploy-app <path>` consumes a spec file. The skill requires a `<path>` argument pointing at a saved spec; invocations without an argument are routed to `/manifest-agent:author-manifest` first, then the user re-invokes `deploy-app` with the saved path. The pre-rewire one-shot "deploy-with-inline-author" UX is gone — `deploy_app_orchestrated` requires a complete `DeploySpec` via `validateSpec()`.

Helper: `scripts/save-manifest-draft.cjs` (atomic write + `0600`, refuses to overwrite). Skills should NOT write spec files via `Write` directly — it bypasses the safety checks.

### Sensitive env values (file-pipe pattern)

Mirrors the mnemonic-import pattern used by `init-agent` / `import-key`. The user creates a dotenv file in a separate terminal (`cat > /tmp/<svc>.env` … Ctrl+D, then `chmod 600`), names the path in chat, and the agent pipes it through `scripts/merge-env.cjs` to mutate the spec file in place. The script outputs only the merged keys (never values), so the chat input box stays clean and the agent never echoes secrets in summaries. Author flow merges into the saved spec at `--spec-file <SAVED_PATH>`; deploy flow materializes the in-memory spec to a `/tmp/.spec-env-<pid>.json`, merges, then `Read`s it back.

What this protects: the chat input never carries secrets, and prose summaries (intent recap, deployment plan) are keys-only by construction. The orchestrated tools' plan + recap renderers (inside `manifest-agent-core/internals/render-*`) use the same env-keys-only discipline; the plugin-side `summarize-manifest.cjs` keeps the redaction discipline for the read-only discovery surface.

What it doesn't: env values still flow into the `build_manifest_preview` and `deploy_app_orchestrated` MCP tool call args at validation + broadcast time, which means they enter the agent's API context for those turns. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Custom domains

`manifest-mcp-node@0.8.0` introduced FQDN support to the lease layer; post-ENG-130 the orchestrated tools own the entire flow end-to-end (plan, fee estimation, dual-tx broadcast, partial-success recovery, DNS pre-check, on-chain verification, persistence). The plugin's role is to invoke the right orchestrated tool and surface the typed return value.

**Spec-file shape (camelCase, mirrors deploy_app input):** top-level `customDomain?: string` and `serviceName?: string`. `serviceName` is required when `customDomain` is set on a stack and must match a key in the `services` map; for single-service specs it's omitted. Spec uses camelCase so the agent can splat the spec into the orchestrated `deploy_app_orchestrated` tool call without renaming.

**Wrapper-file shape (snake_case, mirrors v2 + chain `service_name`):** `custom_domain?: string` and `custom_domain_service_name?: string` added at `schema_version: 3`. agent-core's `saveManifest()` writes wrappers in this same shape to `$MANIFEST_AGENT_DATA_DIR/manifests/<lease_uuid>.json` (which the plugin points at `$MANIFEST_PLUGIN_DATA`), so the read-only helpers (`summarize-manifest.cjs`, `list-saved-manifests.cjs`) continue to surface them safely. v2 wrappers remain readable; missing v3 fields render as undefined.

**Naming asymmetry rationale:** spec → camelCase (deploy_app input contract); wrapper → snake_case (existing v2 + chain response convention). Each layer mirrors its source-of-truth.

**Where the new tools live:** `set_item_custom_domain` and `lease_by_custom_domain` are in `manifest-mcp-lease` (NOT `manifest-fred`); the PreToolUse matcher uses the `mcp__manifest-lease__…` form. The `manage-domain` skill's `lookup` branch calls `lease_by_custom_domain` directly (DECISION 5); `set` and `clear` route through `mcp__manifest-agent__manage_domain_orchestrated` which dispatches `set_item_custom_domain` internally.

**Dual-tx broadcast (deploy-app with `customDomain`):** the orchestrated tool itemizes both fees in its plan-elicitation prompt, broadcasts both inside one MCP tool call, and routes partial-success failures through agent-core's recovery dispatch (retry-set-domain / salvage-without-domain / cancel-or-close). The single PreToolUse permission prompt covers both inner broadcasts.

**Known limitation (unchanged from pre-rewire):** `manage-domain` set/clear operations do NOT refresh the saved wrapper's `custom_domain` field — the persistence path requires the canonical `manifest_json` bytes which manage-domain never has. The wrapper's `custom_domain` may go stale until the next `deploy-app` run for that lease; consumers needing the live value should query the chain via `mcp__manifest-lease__leases_by_tenant` or `mcp__manifest-lease__lease_by_custom_domain`.

## Saved post-deploy records

Post-ENG-130, agent-core's `saveManifest()` writes the wrapper to `$MANIFEST_AGENT_DATA_DIR/manifests/<lease_uuid>.json` (mode `0600`, parent dir `0700`). The plugin sets `MANIFEST_AGENT_DATA_DIR = $MANIFEST_PLUGIN_DATA` in `start-server.cjs` so the wrapper lands at the same path the plugin's read-only helpers already index — existing v2 + v3 wrappers stay cross-readable.

Wrapper schema v3 (written by agent-core; shape unchanged from pre-rewire): `{ schema_version: 3, lease_uuid, deployed_at_iso, deployed_at_unix, chain_id, image, size, meta_hash_hex, format, manifest_json, custom_domain?, custom_domain_service_name? }`. `manifest_json` is the canonical Fred-rendered string and may contain sensitive env values — skills must NOT pretty-print it unredacted.

**Read surface (plugin-side, kept per DECISION 2):** `summarize-manifest.cjs` produces a redacted summary (env keys only, FQDN-safe). `list-saved-manifests.cjs` enumerates the wrapper directory for the lease-UUID pickers in `manage-domain` Step 2b and `troubleshoot-deployment` Step 1. Both are consumed by skills via subprocess; skills MUST NOT `Read` or `Write` wrappers directly.

**Write surface:** agent-core owns it. The plugin's old `save-manifest.cjs` + `remove-manifest.cjs` helpers are deleted (DECISION 2 — agent-core's `saveManifest()` and cleanup branch inside `closeLease`'s recovery dispatch cover both).

Naturally-expired leases leave their saved manifest in place — the file is the historical record. There is no periodic sweep. Lease lifecycle (active / closed / expired) is queried fresh from chain state via `app_status` rather than tracked in the wrapper.

### Wrapper schema evolution

When changing the wrapper shape:

- **Writer**: in `manifest-agent-core`'s `internals/save-manifest.js`. Bump there. The plugin doesn't own the writer post-rewire.
- **Readers (plugin-side)**: `summarize-manifest.cjs`, `list-saved-manifests.cjs`. Readers MUST treat unknown-newer wrappers as readable to the extent of their known fields, and missing optional fields as `undefined`.
- **Tests**: `tests/summarize-manifest.test.cjs` is the canonical place to add a fixture asserting the new shape AND a v(N-1) fixture asserting backward read compatibility. Coordinate the bump with the agent-core release.

There is no migration step — the wrapper is a record, not a config file. A v2 wrapper stays v2 on disk forever.

## Operation journal

Every state-changing skill appends one record per invocation to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` (UTC, mode `0600`, parent dir `0700`). Records capture intent, plan summary, tool calls (`args_redacted` per `_journal.cjs#redactArgs`), outcome, errors, recovery actions, and final state. Schema docstring lives at the top of `_journal.cjs`. The skill `/manifest-agent:journal` is the canonical reader.

**Writing**: skills pipe a JSON record to `journal-write.cjs`. The writer auto-fills `timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` (from `$MANIFEST_SESSION_ID`); runs `validateRecord` (fail-closed against `SECRET_KEY_DENYLIST` — see below); appends one line via `fs.appendFileSync(... { flag: 'a' })`. Concurrency story: on Linux ext4 / xfs the inode mutex serializes concurrent `write(2)` calls to a regular file, so a record under `MAX_RECORD_BYTES` (4 KiB) appends without interleaving in practice — best-effort, not a POSIX guarantee (`PIPE_BUF` formally applies to pipes / FIFOs only). Records exceeding 4 KiB are replaced with a smaller `journal_truncated` marker so realistic concurrent writes stay in the single-`write(2)` regime and the daily file never carries a torn line.

**Redaction discipline** — same posture as `summarize-manifest.cjs`:
- Env maps render as sorted keys, never values.
- The writer is fail-closed (NOT strip-and-continue): any key in the record tree matching `_journal.SECRET_KEY_DENYLIST` (`mnemonic`, `password`, `private_key`, `secret_key`, `api_key`, `auth_token`, `bearer_token`, all with optional `_`/`-` separators) makes `journal-write.cjs` exit 1 and refuse to append. Skills must redact via `_journal.redactArgs` before piping.
- `manifest_json` is reduced via the in-process `summarizeSpec()` function inside `_journal.cjs` (env keys-only, never values; mirrors the now-deleted standalone `summarize-spec.cjs` script's output shape).
- Lease UUIDs, addresses, image refs, custom domains, gas-token symbols ARE captured (legitimate non-sensitive blockchain identifiers).

**Skills that DON'T write a record**: `manage-domain` lookup sub-flow (read-only, ungated direct chain query), `troubleshoot-deployment` when the user picks "Keep" instead of cleanup (read-only diagnostic — matches pre-rewire posture). The `/manifest-agent:journal` query skill is also read-only.

**Post-ENG-130 fidelity reduction (DECISION 4)**: each state-changing skill now writes ONE `tool_calls[]` entry per orchestrated invocation — the outer `mcp__manifest-agent__*_orchestrated` call. The wrapper dispatches multiple inner broadcasts internally (e.g. `deploy_app_orchestrated` calls `cosmos_estimate_fee` + `deploy_app` + maybe `set_item_custom_domain` + `app_status` + cleanup primitives), but skill prose can't observe those MCP-wire-level events from a bash subprocess. The pre-rewire deploy-app record had ~8 inner-tool entries; post-rewire it has 1. The journal still captures intent, plan_summary, outcome, recovery_actions, and a `result_summary` mined from the orchestrated tool's structured return value — sufficient for audit/grep ("what did I deploy on 2026-05-25?"), but coarser than the pre-rewire per-inner-tool trace. The trade-off is deliberate: deeper fidelity would require either (a) embedding `journal_events[]` in agent-core's return values (an upstream change leaking the plugin's `SECRET_KEY_DENYLIST` + record schema across packages) or (b) the wrapper writing directly to `$MANIFEST_AGENT_DATA_DIR/journal/` (which would force the plugin's redaction discipline + schema into the wrapper). Neither is worth the cross-repo coupling.

**Troubleshoot's two-entry exception**: when the user picks cleanup on `troubleshoot-deployment`, the skill makes TWO orchestrated calls in one run — first `mcp__manifest-agent__troubleshoot_deployment_orchestrated` (the diagnostic), then `mcp__manifest-agent__close_lease_orchestrated` (the cleanup). Per the "one entry per orchestrated invocation" rule, both appear in `tool_calls[]`. This is intentional: the diagnostic call's `result_summary` (the markdown report) is part of the audit trail leading to the close decision. The read-only diagnostic-only path (user picks "Keep") writes no record — matches pre-rewire posture.

**Failure-path records**: `deploy-app` writes a record at every terminal point — non-throw success, throw with a recovery branch, or user cancellation inside the orchestrated tool's elicitation. `manage-domain` writes for set/clear regardless of verify outcome (success/partial/failed). `troubleshoot-deployment` writes only when `close_lease_orchestrated` actually fired (Keep branch is read-only).

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

- [`docs/scripts.md`](docs/scripts.md) — per-script catalog (flags, stdin contracts, call site rules).
- [`docs/testing.md`](docs/testing.md) — running tests, adding tests, fixture conventions, exercising scripts outside Claude Code.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch naming, commit conventions, PR checklist.
- [`docs/release.md`](docs/release.md) — version-bump flow and tagging.

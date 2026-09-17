# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code and native Codex plugin (`manifest-agent`) that bootstraps an autonomous agent for the Manifest blockchain. It installs MCP tooling, manages keypairs, fetches chain registry data, and configures everything so the agent can interact with testnet or mainnet.

**Shared workflow source:** edit `workflows/<name>.md`; run `npm run build:skills`
to regenerate the shipped Claude skills. `npm run build:codex` checks those
files and builds a separate native package in `dist/codex`. Host fragments
in `hosts/` contain only host integration differences. The builder resolves
MCP names, skill invocations, local tools and questions before installation;
the model never translates Claude tool names into Codex names.

## Architecture

**Plugin root is read-only in production.** Marketplace installs copy the plugin to `~/.claude/plugins/cache/`. All mutable state lives in `${CLAUDE_PLUGIN_DATA}` — Claude Code's persistent per-plugin data directory, resolved at runtime to `~/.claude/plugins/data/<id>/` and exposed to scripts as `$MANIFEST_PLUGIN_DATA` (exported by the SessionStart hook).

That path is preserved for Claude. Codex resolves its independent data root
through `_host.cjs`: `MANIFEST_CODEX_DATA`, otherwise
`${XDG_DATA_HOME:-$HOME/.local/share}/manifest-agent/codex`. Host adapters
supply the same `MANIFEST_PLUGIN_ROOT`, `MANIFEST_PLUGIN_DATA`, `NODE_PATH`
contract. Mutable config, wallets, chain metadata, drafts, saved manifests,
journals and dependency installs are isolated per host. Shared data directories
are unsupported; no automatic wallet or chain migration occurs.

Codex's `codex-server.cjs` validates packaged assets before locked setup, then
wraps the shared launcher with `_mcp-bridge.cjs`. The agent server injects the
generated runtime policy into MCP initialization once. Every adapter refuses
reviewed mutations without native form support and confirms direct writes.
Orchestrated forms, progress, cancellation and partial
results remain upstream-owned. Codex ships no Claude hooks and does not use
`CLAUDE_ENV_FILE`. Skills source their packaged `env.sh` helper in each shell
call; it locates `host-env.cjs` without pre-existing root exports. See
`docs/codex.md` and `docs/host-acceptance.md`.

```
Plugin root (read-only)          Runtime data ($MANIFEST_PLUGIN_DATA)
├── scripts/*.cjs                ├── config.json                  (0600, credential reference)
├── skills/*/SKILL.md            ├── keys/agent-*.json            (0600, encrypted wallets)
├── hooks/hooks.json             ├── chains/{mainnet,testnet}.json
├── .mcp.json                    ├── manifests/<lease-uuid>.json  (0600, post-deploy records)
├── package.json                 ├── manifests-drafts/*.json      (0600, user-managed drafts)
                                 ├── credentials/*.json           (0600, explicit file fallback only)
                                 ├── journal/<YYYY-MM-DD>.jsonl   (0600, append-only audit trail)
                                 ├── node_modules/                (deps installed here)
└── package-lock.json            ├── package.json + package-lock.json (copied)
                                 └── .runtime-install.json         (completion record)
```

**Data flow**: Skills run scripts → scripts write to `$MANIFEST_PLUGIN_DATA` → MCP wrapper reads `config.json` at startup → spawns MCP binary with computed env vars.

**Dependency resolution**: All scripts are CJS (`.cjs`) because NODE_PATH only works with CommonJS, not ESM. The SessionStart hook exports `NODE_PATH=$MANIFEST_PLUGIN_DATA/node_modules` once via `CLAUDE_ENV_FILE`, so every `node` invocation in skill bash blocks (and ad-hoc dev usage) inherits it without per-site prefixing.

**Plugin root + data discovery**: The SessionStart hook exports `MANIFEST_PLUGIN_ROOT` and `MANIFEST_PLUGIN_DATA` via `CLAUDE_ENV_FILE`, mirroring Claude Code's `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` substitutions (which only expand inside `.mcp.json`, hooks, etc., not in scripts). Skills use `$MANIFEST_PLUGIN_ROOT` to locate scripts and `$MANIFEST_PLUGIN_DATA` for runtime files. Scripts read `process.env.MANIFEST_PLUGIN_DATA` (the `_io.cjs` `getDataDir()` helper centralizes the lookup + missing-var error).

**Dependency bootstrap**: SessionStart runs `scripts/setup-runtime.cjs`, the same command used by onboarding and repair. It copies both tracked manifests into the data directory and runs `npm ci --omit=dev --ignore-scripts` when the package/lock fingerprint or installed dependency files fail validation. A completion record is written only after successful verification. Setup uses a process lock with Linux start-time identities and preserves config, keys, journals, drafts, and saved deployments. It never installs into the plugin root. Stable Node 22.19.0+ is required; CI tests that floor and Node 24. Root dependency overrides mirror the released upstream 0.22.0 fixes (ENG-269/270/748), which npm does not propagate from a dependency: axios 1.19.0, protobufjs 7.6.5, ipaddr.js 2.4.0, and the Manifest stargate fork. Keep them aligned when upgrading.

## Key Patterns

**All scripts use CJS** — `require()`, async IIFE with `.catch(() => process.exit(1))`. Use `getDataDir()` from `_io.cjs` for the data directory path; never compose `homedir() + '.manifest-agent'` (the latter is the legacy pre-v0.5 path).

**Secrets via stdin** — The user creates a fresh private mnemonic file in a
separate terminal and supplies only its path. Redirect that file into
`import-key.cjs` with `< 'MNEMONIC_FILE'`, then pipe its output directly to
`write-config.cjs`. Do not read the mnemonic into model context or place it in
a heredoc, command-line argument, or chat message.

Terminal secret-file recipes use POSIX assignments such as
`MNEMONIC_INPUT_PATH=$(mktemp)`. Ask fish users to start `bash` in their separate
terminal before following the recipe and remain in that shell through cleanup;
do not offer unverified fish translations.

**Underscore-prefix helpers** — Scripts named `_<topic>.cjs` (`_io.cjs`, `_uuid.cjs`, `_gas-price.cjs`, `_spec.cjs`, `_https-json.cjs`, `_journal.cjs`) are sibling-only modules consumed via `require('./_X.cjs')`. Skills MUST NOT shell out to them. The post-ENG-130 `humanize-denom.cjs` is a documented exception because it's conceptually a renderer composed by another renderer (`render-balance.cjs`); see the "Renderer / structural summarizers" subsection of the inventory below.

**MCP wrapper** (`start-server.cjs`) — Waits for concurrent SessionStart setup (2-second pre-lock grace, 25-second total bound) before spawning; failure diagnostics identify the missing/incomplete dependency. Reads `config.json`, builds env vars, spawns `$MANIFEST_PLUGIN_DATA/node_modules/.bin/manifest-mcp-<name>` directly (not npx — 30ms vs 800ms startup). Forwards SIGTERM/SIGINT/SIGHUP. Uses `stdio: 'inherit'` so MCP JSON-RPC passes through transparently.

**Configuration precedence** — Config owns chain, gas-price/multiplier and wallet variables. The launcher removes inherited values before applying the selected config, including stale optional endpoints and mnemonic fallback. `agent.keyFile` must exist and `agent.keyPasswordRef` must resolve through `_credentials.cjs`; legacy `agent.keyPassword` is migrated before launching; an explicit empty password is preserved, although upstream 0.22.0 rejects empty-password encrypted wallets. The child runs from an owned empty temporary directory so dotenv cannot load a workspace `.env`, and `DOTENV_CONFIG_QUIET=true` keeps stdout protocol-only. The temporary directory is removed on exit; generic transport settings such as proxies remain inherited. `COSMOS_MAX_GAS` remains an explicit operator override of the upstream gas ceiling; it is not a config-owned field. Invalid values are rejected upstream.

**Reinitialization limit** — `write-config.cjs` rebuilds config without retaining
`gasMultiplier`. Re-running `init-agent` therefore resets a custom multiplier
to the runtime default `1.5`. The standalone `import-key` workflow captures the
safe status first and restores a non-null multiplier in a separate checked
`update-config.cjs` call. If restoration fails, the new wallet is already
configured: report a partial outcome and retry only the multiplier update
after resolving the error. Do not rerun the import or claim completion.

## Credential storage and startup identity (ENG-85)

`_credentials.cjs` owns native credential access, the explicit
`MANIFEST_CREDENTIAL_STORE=file` fallback, secret-safe config reading and the
exclusive `.config.lock` file shared by migration and config writers. Ownership
uses a token and Linux PID start time; acquisition waits at most 20 seconds.
The exclusive `.config.lock.reclaim` guard serializes stale recovery. A crashed
reaper requires manual guard removal only after all configuration writers and
MCP launchers have stopped; the timeout diagnostic names the recovery path.
Native store-access failures share a secret-free 30-second retry marker keyed by
backend and config hash for automatic hook/launcher attempts. Manual migration
and config writes retry immediately; file storage and local validation failures
do not create the marker. A new credential uses a
unique ID and must round-trip before config references it. Migration atomically
removes the plaintext field and records `credentialMigration`; failed storage
preserves the previous config. `update-config --status` remains read-only.
All launchers migrate/resolve, including Codex without a lifecycle hook.

Claude SessionStart runs migration and `session-identity.cjs` after setup on
new sessions only. The
identity query invokes only chain MCP `cosmos_query` bank/balance for the gas
coin, and bounds its lifetime and protocol size. Structured hook JSON supplies
the complete runtime policy and public report through `additionalContext`, with
the report also in `systemMessage`. Resume, clear, compact and fork still receive
policy and environment exports but skip the probe. Manual identity CLI output
stays on stderr. Low testnet balance produces a hint, never a faucet call. See `docs/identity.md` for
platform prerequisites, backup requirements and verification limits.

`session-hook.cjs` buffers and validates reporter output before publishing it.
Optional reporter crashes or invalid output fall back to the complete plain
policy with exit 0. Direct file writes keep Node wrapper/preload noise out of
reports and tool-shell exports without requiring extra inherited descriptors or
inline Node evaluation. Runtime setup and environment failures still fail the hook.

## Open question decisions (ENG-130 rewire)

The ENG-130 rewire left five non-obvious decisions documented here so future readers can map skill / script choices back to the rationale:

- **DECISION 1 — `author-manifest` stays plugin-side.** `manifest-mcp-agent` ships no `build_manifest_preview_orchestrated` tool (would have been an upstream ENG-204-tier ticket). The standalone draft-creation flow remains in the plugin over the surviving `save-manifest-draft.cjs` + `merge-env.cjs` helpers. The rewired `deploy-app` skill takes one input (a file path) and points non-file input at `/manifest-agent:author-manifest`; `deploy_app_orchestrated`'s `validateSpec()` requires a complete `DeploySpec` up front, so the rewire converged on author → deploy as two explicit steps rather than the pre-rewire one-shot "deploy with inline author" UX.
  ENG-260 keeps the exact catalog choice in the draft: `size` plus `skuUuid`
  and `providerUuid` for compute. MCP 0.22.0 honors these selectors. Storage
  IDs are recorded as documentation-only metadata because upstream still
  resolves storage by name on the compute provider; the plugin rechecks
  the current catalog before deploying a draft with storage identity metadata.
- **DECISION 2 — saved-manifest read surface stays; write surface moves.** Deleted: `save-manifest.cjs`, `remove-manifest.cjs` (agent-core's `saveManifest()` owns persistence end-to-end via `MANIFEST_AGENT_DATA_DIR`; cleanup is inside `closeLease`'s recovery dispatch). Kept: `list-saved-manifests.cjs` + `summarize-manifest.cjs` (read-only discovery surface used by the lease-UUID pickers in `manage-domain` Step 2b and `troubleshoot-deployment` Step 1) and `save-manifest-draft.cjs` (for `author-manifest`'s draft creation).
- **DECISION 3 — FQDN validation + DNS pre-check move into agent-core.** Deleted: `validate-domain.cjs`, `dns-precheck.cjs`. agent-core's `manageDomain` runs `validateArgs` (RFC 1123 hostname + scheme rejection + ≤253 char cap) server-side and runs the warn-only DNS probe internally. `build_manifest_preview` validates container manifest fields only; custom-domain metadata is validated during orchestrated deployment.
- **DECISION 4 — journal mechanism is option-a (skill-side, single-entry-per-orchestrated-call).** The skill prose pipes a record to `journal-write.cjs` with ONE `tool_calls[]` entry per orchestrated invocation. `args_redacted` is produced by `_journal.cjs#redactArgs`'s per-tool reducer (added in ENG-130 for the four new tools). `result_summary` is mined from the orchestrated tool's structured return value. The journal does NOT enumerate inner broadcasts the wrapper dispatches — see "Operation journal" below for the full fidelity-trade-off discussion. `troubleshoot-deployment` is the documented exception: it writes two `tool_calls[]` entries when the cleanup branch fires, because the close call is a separate skill-driven orchestrated tool call after the diagnostic returns (still one entry per orchestrated invocation; the skill just makes two invocations in that branch). The alternative (wrapper-side journal writes) was rejected to keep the plugin's secret-key denylist + record schema out of the upstream package.
- **DECISION 5 — lookup is a dedicated read-only orchestrator.** MCP 0.22.0 provides `lookup_custom_domain_orchestrated({fqdn})`. `manage_domain_orchestrated` accepts set/clear only; there is no action-specific permission exemption.

## Skills

Invoked as `/manifest-agent:<skill-name>`. All skills guard that `$MANIFEST_PLUGIN_ROOT` is set (Step 0).

- **init-agent** — Full setup: install deps, fetch registry, choose chain, generate or import key, write config
- **import-key** — Import existing mnemonic (requires init-agent first)
- **switch-chain** — Switch testnet/mainnet with mainnet confirmation before write
- **set-gas-price** — Select the gas fee token at its registry minimum price and/or change the gas multiplier
- **refresh-registry** — Re-fetch chain data from Cosmos chain registry
- **author-manifest** — Plugin-side draft creation. Builds + validates a Fred spec via `mcp__plugin_manifest-agent_manifest-fred__build_manifest_preview`, saves via `save-manifest-draft.cjs` to `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json` (or a user-chosen path). Preserves supplied image digests and asks for an explicit mutable-tag choice per service. No readiness pre-flight — the orchestrated deploy tool re-checks at broadcast time. No client-side image inspection or domain validation. MCP 0.22.0 exposes no tag-resolution API; preview validates the manifest, not registry contents. See DECISION 1 and the ENG-117 boundary below.
- **troubleshoot-deployment** — Picker (`$ARGUMENTS` → `manifest://leases/active` → `list-saved-manifests.cjs` → lookup-by-FQDN → user-paste) plus a thin invocation of `mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated`, which is a pure chain query returning pre-rendered Markdown. The cleanup elicitation, when the user opts in, drives `mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated` as a separate tool call. The outer close invocation is gated before execution; its internal SDK operations do not trigger separate host PreToolUse events.
- **deploy-app** — Thin invocation of `mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated` over a complete spec JSON file. `/manifest-agent:deploy-app <path>` is the only input mode — the orchestrated tool requires a fully-formed `DeploySpec` (`validateSpec()` runs first), so non-file input directs the user at `/manifest-agent:author-manifest`. The wrapper owns plan rendering, fee itemization, partial-success recovery, and manifest persistence (via `MANIFEST_AGENT_DATA_DIR`) end-to-end through MCP elicitation. The skill resolves the file, invokes the tool, renders the typed `DeployResult`, and journals the run.
- **manage-domain** — Lookup uses `mcp__plugin_manifest-agent_manifest-agent__lookup_custom_domain_orchestrated({fqdn})`, returning `{action:"lookup",fqdn,lease:{leaseUuid}|null}`. Set/clear use `manage_domain_orchestrated`, returning `{action,leaseUuid,verified,finalCustomDomain}` after native confirmation and verification. Errors may follow a successful broadcast; query the existing lease before proposing a retry.
- **restart-app** — Restart a running app via `restart_app` without closing the lease. Per the `scripts/session-start.sh` runtime policy, `restart_app` is a provider HTTPS call, NOT a Cosmos broadcast — no gas, no fee estimate, no `cosmos_estimate_fee` step. The skill inlines its own textual confirm. PreToolUse still gates the tool. Pre-call: pipe `chainState.state` through `scripts/decode-lease-state.cjs --state "$STATE" --json` and refuse unless the decoded `name` is `LEASE_STATE_ACTIVE`. The helper handles all chain encoding forms (int `2`, stringy-int `"2"`, canonical `"LEASE_STATE_ACTIVE"`) per its companion test (`tests/_lease-state.test.cjs`). Post-call: re-query `app_status` once and pipe the new state through the same decoder; tag the journal `recovery_actions` with `["restart-post-verify-not-active"]` on regression.
- **list-releases** — Read-only call to `app_releases`; renders the version history via `render-releases.cjs` as a Markdown table sorted newest first. True rollback (re-deploying a prior release) is intentionally out of scope — track separately if/when needed.
- **balance** — Read-only call to `credit_balance`; renders wallet balances + credit account state + burn rate + runway hours via `render-balance.cjs` (humanizing denoms via `humanize-denom.cjs`). Optional `$ARGUMENTS` is a bech32 tenant address; default is the agent's own address.
- **list-providers** — Read-only call to `get_providers`; renders the provider table via `render-providers.cjs`. Optional `--all` argument flips `active_only` to false (default surfaces only active providers).
- **journal** — Read-only audit-trail query over `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl`. Filter by date / skill / lease UUID / outcome / signer. Markdown or JSONL output. The journal is written by every state-changing skill at the end of each invocation; this skill is the canonical reader.

### `references/` files and cross-skill loading

Codex packages generate `references/runtime-policy.md` from the canonical
transaction policy in `scripts/session-start.sh`, replacing only the host
enforcement paragraphs. Consumers are all Codex skills and the MCP adapter;
variables are `MANIFEST_PLUGIN_ROOT` and `MANIFEST_PLUGIN_DATA` supplied by
`host-env.cjs`. Restart-confirmation fragments in `hosts/<host>/` are consumed
only by the `restart-app` generator with `LEASE_UUID` and `IMAGE` in scope.

The former plugin-root
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

**Now in agent-core (consumed via `manifest-mcp-agent`):** intent recap rendering, `DeploymentPlan` block rendering, readiness evaluation, `deploy_app` response + error classification, partial-success recovery dispatch, URL extraction from typed connection payloads, lease-state enum decoding, troubleshoot report rendering, FQDN format validation, DNS resolution pre-check, generic post-broadcast verify-and-recover dispatch, set-domain CLI arg construction. All of these live inside the five `mcp__plugin_manifest-agent_manifest-agent__*_orchestrated` tools — the plugin no longer owns them.

**In prose:** asking the user open-ended questions (FQDN strings, env-file paths, service names for stack-lease custom-domain), resolving lease UUID from multiple sources (`$ARGUMENTS` / `manifest://leases/active` / `list-saved-manifests.cjs` / lookup-by-FQDN / paste), branching on the orchestrated tool's typed return value, and writing the journal record.

The motivation: deterministic logic in prose accumulates LLM-paraphrasing drift across runs and can silently regress when models change. Scripts pin the contract — and the orchestrated tools take that discipline a step further, pinning the user-facing wording inside agent-core's `internals/render-*` modules.

> *Hindsight from ENG-130*: when a rewire deletes helpers whose logic moves elsewhere AND inlines residual decode paths into prose on the grounds they're "trivial enums," the survivors are the ones that need the **most** discipline, not the least — they're now the only place the logic lives. If correctness depends on a chain-proto enum value, a wire-encoding detail, or any invariant a future agent-model could paraphrase wrong, it belongs in a tested CJS script.
>
> **Rule of thumb: delete orchestration; keep primitives.** Tier examples — primitives (small, type-narrow, testable invariants — keep): `_io.cjs`, `_uuid.cjs`, `_spec.cjs`, `decode-lease-state.cjs`. Orchestration (multi-step decision flows that LLMs can carry — delete and move into agent-core): `render-deployment-plan.cjs`, `classify-deploy-error.cjs`, `evaluate-readiness.cjs`. The PR #9 Copilot review caught a real instance of this failure mode: an inverted `LEASE_STATE_ACTIVE === 1` in inlined skill prose after the original `_lease-state.cjs` test was deleted. The primitive was restored.

The enumeration above is illustrative; see "Scripts inventory" below for the full per-script catalog.

## Scripts inventory

Identity helpers added for ENG-85:

- `scripts/_credentials.cjs` — synchronous store/readback/resolve, sanitized config
  reader, shared config lock and idempotent plaintext migration.
- `scripts/_wincred.ps1` — Windows Credential Manager native API bridge; JSON
  requests and secret responses use stdin/stdout pipes owned by the adapter.
- `scripts/migrate-credentials.cjs` — migration CLI; no stdout, sanitized stderr.
- `scripts/session-hook.cjs` — CommonJS hook transport for environment exports,
  source selection and validated report files; owns sanitized failure diagnostics.
- `scripts/session-identity.cjs` — bounded chain MCP balance query and public
  identity/faucet advisory; manual stderr or internal structured hook output;
  safe no-op before initialization.

The per-script catalog (CLI entry points, renderer-exception modules, `_<topic>.cjs` helpers, hook scripts) lives in [`docs/scripts.md`](docs/scripts.md). Read that file when you need to know a specific script's flags, stdin contract, or call site rules. The conventions that apply to the catalog as a whole:

- Underscore-prefixed files are sibling-only modules consumed via `require('./_X.cjs')` — skills MUST NOT shell out to them.
- Non-underscore files are normally CLI entry points; `humanize-denom.cjs` is the post-ENG-130 documented exception (a denom→symbol renderer composed by `render-balance.cjs`).
- CLI scripts exit `1` on argv/usage errors with a one-line stderr diagnostic.
- `pre-tool-use.cjs` is the hook payload classifier, invoked by `pre-tool-use.sh`. Its private output is `ask-direct`, `ask-orchestrated`, or `defer`; invalid events exit nonzero. The shell clears Node preload variables and maps only those tokens to fixed host JSON or no decision. Errors, empty output, and unexpected output produce `deny`. The helper exports `decidePermission` for tests.
- `setup-runtime.cjs` installs or repairs the locked data-directory runtime; `_runtime.cjs` provides the shared Node floor, package/lock fingerprint, process-owner checks, and completion validation used by setup and the launcher. Only setup reclaims stale locks; launchers ignore confirmed dead owners. Completion is platform/architecture-specific but shared across supported stable Node majors for the current JavaScript-only lock. Dependency snapshots and completion validation reject regular `.node` files; adding native dependencies requires explicit Node-specific runtime support. See their tests and the catalog for recovery behavior.
- `check-storage-selection.cjs` compares a draft's storage identity metadata
  with `browse_catalog` before deployment. It rejects changed or ambiguous
  storage selections; it does not add storage UUID support to MCP.
- `check-image-references.cjs --spec-file <path>` uses `_image-ref.cjs` to
  classify full references as `digest`, `tag`, or `malformed-digest` without
  registry access. Authoring and deployment stop on malformed digests; the
  draft saver enforces the same check before writing. Syntax validity does
  not establish registry availability or validate the full repository grammar.
- `ci/evidence-check.cjs` checks current host-report source hashes and distinguishes historical commit evidence; CI runs it alongside policy completeness. See `docs/approval-validation.md` for rerun and history requirements.
- `ci/check-powershell.ps1` parses the shipped PowerShell scripts without running Windows APIs. Tests verify syntax-error rejection, Unicode stdin, and that ACL/invalid operations skip native compilation.
- `ci/terminal-host-smoke.cjs` drives the actual Claude and Codex terminal UIs through a private tmux socket, a loopback model fixture, and marker-only MCP tools. It records rendered prompts, input keys, progress, results and mutation counts. See `docs/host-acceptance.md` for the pinned CLI versions and scope.
- `ci/lease-state-parity.cjs --data-dir <runtime-dir>` compares the plugin's numeric `STATES` table with the installed manifestjs `LeaseState` enum, excluding the SDK's `UNRECOGNIZED = -1` sentinel. CI runs it after runtime installation; its unit tests use fixtures and require no runtime packages.
- `scripts/_chain-config.cjs` mirrors the pinned MCP core's endpoint, chain-ID and gas-price predicates. `scripts/_chain-registry.cjs` applies registry shape checks, lowercases endpoint schemes for CosmJS HTTP transport, and rejects unusable fee-token prices before cache writes. `_gas-price.cjs` also validates old cached fee data and expands numeric exponents to decimal strings.
- `ci/chain-config-parity.cjs --data-dir <runtime-dir>` compares those predicates and persisted registry/config controls with the installed MCP core. CI runs it after runtime installation; ordinary unit tests remain dependency-free. When upgrading the runtime, review any policy drift instead of only changing the expected vectors.
- Use `rg -n '<script>.cjs' workflows/ skills/ scripts/ ci/` to locate callers. Change shared workflow sources and regenerate shipped skills together.

## config.json → MCP env var mapping

`start-server.cjs` maps config fields to env vars for the MCP child process. Five servers are registered: `manifest-chain`, `manifest-lease`, `manifest-fred`, `manifest-cosmwasm`, and (post-ENG-130) `manifest-agent`.

| Config path | Env var | Required |
|---|---|---|
| `chains[activeChain].chainId` | `COSMOS_CHAIN_ID` | yes |
| `chains[activeChain].rpcUrl` | `COSMOS_RPC_URL` | yes |
| `chains[activeChain].restUrl` | `COSMOS_REST_URL` | no (omit if falsy) |
| `chains[activeChain].converterAddress` | `MANIFEST_CONVERTER_ADDRESS` | required by CosmWasm startup; omitted elsewhere when absent |
| `chains[activeChain].faucetUrl` | `MANIFEST_FAUCET_URL` | no (omit if falsy — only set for testnet; chain server registers `request_faucet` when present) |
| `gasPrice` | `COSMOS_GAS_PRICE` | yes |
| `gasMultiplier` | `COSMOS_GAS_MULTIPLIER` | no (omit if falsy, default 1.5) |
| `agent.keyFile` | `MANIFEST_KEY_FILE` | yes (existing file) |
| `agent.keyPasswordRef` → credential store | `MANIFEST_KEY_PASSWORD` | yes (resolved string, including empty; legacy plaintext migrated first) |

**Agent-server-only env vars** (the first two are always set for `agent`; the guarded-fetch override is forwarded only when present):

| Computed value | Env var | Required |
|---|---|---|
| `$MANIFEST_PLUGIN_DATA` | `MANIFEST_AGENT_DATA_DIR` | yes (agent-core's `saveManifest()` writes to `<dataDir>/manifests/<lease_uuid>.json` — the same tree the read-only helpers `summarize-manifest.cjs` + `list-saved-manifests.cjs` already index, keeping wrappers cross-readable) |
| `$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json` | `MANIFEST_CHAIN_DATA_FILE` | yes (denom-map humanization for the orchestrated tool's plan + result rendering) |
| `$MANIFEST_AGENT_FETCH_GUARDED` (parent env) | `MANIFEST_AGENT_FETCH_GUARDED` | no (forwarded only when set in parent shell; the agent server defaults to `1` / ON when absent — the SSRF-guarded fetch is on by default) |

## Transaction Behavior (runtime policy)

**Do not edit the policy text in this file.** The canonical, runtime-facing transaction policy lives in `scripts/session-start.sh` as a heredoc and is injected into every Claude session via the SessionStart hook. Plugin CLAUDE.md files are developer docs — they are not loaded into sessions that USE the plugin, so any policy written here never reaches the runtime agent. Edit `scripts/session-start.sh` if you need to change the rules.

The approval boundary is the host-visible tool call:

1. **Runtime guidance (SessionStart)** — `scripts/session-start.sh` injects the workflow policy. It directs orchestrated mutations through native MCP elicitation and describes the fee/action recap for direct write tools. Prose guidance is not a signer or an execution guard.
2. **Host permission (PreToolUse)** — `scripts/pre-tool-use.sh` requests `permissionDecision: "ask"` for mutating host calls before their execution. A denied outer call must never reach the MCP server. The server's internal SDK operations do not create additional host PreToolUse events.
3. **In-call elicitation** — after host permission, an orchestrated tool requests plan/action, mainnet, or recovery confirmation through MCP `elicitInput`. The pinned deploy plan includes estimated fees; manage-domain and close recaps do not guarantee numeric estimates. Claude Code renders these requests and returns user responses. The agent must not reprint or answer them, and should not add redundant prose confirmations.

To change plan or recovery wording, edit agent-core's upstream renderers. The hook cannot inspect the internal workflow, verify that a fee recap was shown, or isolate the signer from other local processes. These checks apply to the configured Claude MCP calls; they are not a sandbox for arbitrary shell commands or direct SDK use.

**Tools gated by the PreToolUse hook** (the exact anchored matcher uses Claude Code's plugin-scoped names):

- `mcp__plugin_manifest-agent_manifest-chain__cosmos_tx`
- `mcp__plugin_manifest-agent_manifest-cosmwasm__convert_mfx_to_pwr`
- `mcp__plugin_manifest-agent_manifest-fred__deploy_app`
- `mcp__plugin_manifest-agent_manifest-fred__restart_app`
- `mcp__plugin_manifest-agent_manifest-fred__restore_app`
- `mcp__plugin_manifest-agent_manifest-fred__update_app`
- `mcp__plugin_manifest-agent_manifest-lease__fund_credit`
- `mcp__plugin_manifest-agent_manifest-lease__close_lease`
- `mcp__plugin_manifest-agent_manifest-lease__set_item_custom_domain`
- `mcp__plugin_manifest-agent_manifest-agent__deploy_app_orchestrated`
- `mcp__plugin_manifest-agent_manifest-agent__manage_domain_orchestrated`
- `mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated`

`lookup_custom_domain_orchestrated` is read-only. `manage_domain_orchestrated` accepts set/clear only, and every invocation requests permission. Read-only diagnostics, including `troubleshoot_deployment_orchestrated`, and the testnet faucet (`mcp__plugin_manifest-agent_manifest-chain__request_faucet`) are intentionally ungated.

A direct write and an orchestrated write are separate host entry points. Both need coverage; matching the direct tool does not cover server-side SDK calls inside an orchestrator. CI checks the installed, pinned package's published MCP tool inventory against the reviewed policy classification. Published annotations and Manifest metadata inform that classification; the check does not execute tool bodies to prove their behavior. The workflow does not maintain a second expected tool list.

**Bypass permissions mode:** an older report, [anthropics/claude-code#37420](https://github.com/anthropics/claude-code/issues/37420), described bypass mode being reset after a hook requested permission. This repository does not establish that behavior for current Claude versions. Record the actual host version and observed behavior when validating; do not promise a prompt or a bypass reset in every mode. See [`docs/approval-validation.md`](docs/approval-validation.md) for the difference between policy tests and real-host evidence.

## Testing Changes

Quick smoke run:

```bash
# Test the plugin locally (SessionStart hook handles locked runtime setup + env export)
claude --plugin-dir .

# Run the unit tests (no MANIFEST_PLUGIN_DATA needed — tests stub it)
npm test
```

For exercising scripts directly without Claude Code, fixture setup, and the per-script test conventions, see [`docs/testing.md`](docs/testing.md).

## Manifest specs (user-managed)

Deployment specs are plain JSON passed as `{spec}` to `deploy_app_orchestrated`.
They require `size` and exactly one of `image` or `services`. The author skill
emits a services map even for one service, with top-level `skuUuid` and
`providerUuid` copied from the selected catalog entry's `sku_uuid` and
`provider_uuid`. Names are display labels and may repeat across or within
providers; UUIDs identify compute selections. The pinned orchestrator resolves
the selected active SKU and verifies its provider before planning/deployment.
`storage`, `customDomain`, `serviceName`, and the compute selectors are
deployment metadata.
Preview only manifest fields: `{services: SPEC.services}` for authored specs.
Direct Fred deploy uses a different contract, including snake-case selectors.

- Flat single-service: `{ size, skuUuid?, providerUuid?, image, port?, env?, labels?, command?, args?, health_check?, storage?, tmpfs?, init? }`
- Authored services map: `{ size, skuUuid, providerUuid, services: { <name>: { image, ports?, env?, depends_on?, ... }, ... }, storage?, storageSkuUuid?, storageProviderUuid? }`

`storageSkuUuid` / `storageProviderUuid` are plugin documentation-only metadata,
not upstream selectors. Storage must be on the compute provider, and its name
must identify exactly one active SKU there. Before deploying a draft carrying
either storage identity field, `check-storage-selection.cjs` verifies both IDs,
the name, and provider against a fresh catalog. It reads the original draft
via `--spec-file` and the JSON catalog on stdin from a file serialized by the
host Write tool. Untrusted catalog values never enter shell source. Compute
`skuUuid` can supply its provider when `providerUuid` is omitted; name and
compute selector whitespace is trimmed as upstream does, without rewriting
the draft. Identifier comparison remains case-sensitive. Failure stops before the
orchestrator; success establishes only the catalog observation. MCP 0.22.0
still resolves storage by name at execution time. Storage UUID pinning needs
the upstream contract change tracked by [ENG-295](https://linear.app/liftedinit/issue/ENG-295).
Older drafts without IDs remain readable and
use upstream name resolution; the plugin does not backfill IDs from names.

Catalog records have no compute/storage category. The user must identify a
provider-documented storage SKU; identity checks do not establish suitability.
MCP 0.22.0 also omits storage pricing from the confirmation plan and the
additional storage lease item from fee simulation. Author/deploy skills
disclose this limitation; an upstream change is required to include storage
in the plan and estimate ([ENG-944](https://linear.app/liftedinit/issue/ENG-944)).

`/manifest-agent:author-manifest` walks the user through building one and saves it (default `$MANIFEST_PLUGIN_DATA/manifests-drafts/<auto-name>.json`, or any user-chosen absolute path inside the drafts dir or the system tmpdir). Spec files are user-managed: hand-edit them in `$EDITOR`, version-control them in your app repo, generate them with a script, etc. The plugin doesn't garbage-collect drafts.

`/manifest-agent:deploy-app <path>` consumes a spec file. The skill requires a `<path>` argument pointing at a saved spec; invocations without an argument are routed to `/manifest-agent:author-manifest` first, then the user re-invokes `deploy-app` with the saved path. The pre-rewire one-shot "deploy-with-inline-author" UX is gone — `deploy_app_orchestrated` requires a complete `DeploySpec` via `validateSpec()`.

Helper: `scripts/save-manifest-draft.cjs` (atomic write + `0600`, refuses to overwrite). Skills should NOT write spec files via `Write` directly — it bypasses the safety checks.

### Image digest boundary (ENG-117)

Authoring preserves user-supplied digest references, offers an explicit
mutable-tag choice for every service, and reports the exact saved images.
The local image-reference checker rejects malformed digest suffixes, which
the pinned preview's loose image validation otherwise accepts. Reports
distinguish malformed digests from valid supplied syntax and unresolved tags.
Deployment forwards those references unchanged. MCP 0.22.0 does not expose
tag resolution; `meta_hash_hex` identifies manifest JSON, not OCI image
contents. Its canonical DeploymentPlan shows the primary image only.
The subsequent native intent confirmation lists all service image references;
it does not resolve tags or attach resolution statuses to those references.

[ENG-954](https://linear.app/liftedinit/issue/ENG-954) blocks automatic pinning
and per-service digest rendering. It must establish matching SDK/MCP types,
resolution/opt-out semantics, and upstream plan/persistence behavior before
the plugin adds tool calls or metadata. The internal inspector currently
returns a selected platform manifest's digest after following a multi-arch
index; it is not a safe substitute for a public index-pinning contract.
See [the integration plan](docs/eng-117-plan.md) for the release gate.

### Sensitive env values (file-pipe pattern)

The user creates a private dotenv file in a separate terminal, names only
its path in chat, and the agent pipes it into `scripts/merge-env.cjs`. Create
the fresh file with `umask 077` and `ENV_INPUT_PATH=$(mktemp)`, then write or
edit it locally using the quoted `"$ENV_INPUT_PATH"`. Use the same pattern
with `MNEMONIC_INPUT_PATH` for mnemonic import; do not reuse a fixed filename,
because `umask` does not change an existing file's permissions. Authoring merges into
the saved draft at `--spec-file <SAVED_PATH>`; the helper emits only key
names. `deploy-app` loads a complete saved spec and has no inline env-entry
or env-merge branch. Follow the shared authoring workflow for file cleanup.

What this protects: the chat input never carries secrets, and prose summaries (intent recap, deployment plan) are keys-only by construction. The orchestrated tools' plan + recap renderers (inside `manifest-agent-core/internals/render-*`) use the same env-keys-only discipline; the plugin-side `summarize-manifest.cjs` keeps the redaction discipline for the read-only discovery surface.

What it doesn't: env values still flow into the `build_manifest_preview` and `deploy_app_orchestrated` MCP tool call args at validation + broadcast time, which means they enter the agent's API context for those turns. Eliminating that exposure entirely needs upstream MCP support for "load env from this path" and is out of scope here.

## Custom domains

`manifest-mcp-node@0.8.0` introduced FQDN support to the lease layer; post-ENG-130 the orchestrated tools own deployment planning and estimated fees, sequential transactions, partial-success recovery, DNS pre-checks, verification, and persistence. Standalone domain/close confirmation recaps do not guarantee numeric fee estimates. The plugin's role is to invoke the right orchestrated tool and surface the typed return value.

**Spec-file shape (camelCase, mirrors deploy_app input):** top-level `customDomain?: string` and `serviceName?: string`. `serviceName` is required when `customDomain` is set on a stack and must match a key in the `services` map; for a flat top-level `image` spec it is omitted. A one-service `services` map is still a stack and needs its service key. Spec uses camelCase so the agent can splat the spec into the orchestrated `deploy_app_orchestrated` tool call without renaming.

**Wrapper-file shape (snake_case, mirrors v2 + chain `service_name`):** `custom_domain?: string` and `custom_domain_service_name?: string` added at `schema_version: 3`. agent-core's `saveManifest()` writes wrappers in this same shape to `$MANIFEST_AGENT_DATA_DIR/manifests/<lease_uuid>.json` (which the plugin points at `$MANIFEST_PLUGIN_DATA`), so the read-only helpers (`summarize-manifest.cjs`, `list-saved-manifests.cjs`) continue to surface them safely. v2 wrappers remain readable; missing v3 fields render as undefined.

**Naming asymmetry rationale:** spec → camelCase (deploy_app input contract); wrapper → snake_case (existing v2 + chain response convention). Each layer mirrors its source-of-truth.

**Where the new tools live:** `set_item_custom_domain` and `lease_by_custom_domain` are in `manifest-mcp-lease` (NOT `manifest-fred`); the PreToolUse matcher uses the `mcp__plugin_manifest-agent_manifest-lease__…` form. The `manage-domain` skill's lookup branch calls `lookup_custom_domain_orchestrated` (DECISION 5); `set` and `clear` route through `mcp__plugin_manifest-agent_manifest-agent__manage_domain_orchestrated` which dispatches `set_item_custom_domain` internally.

**Dual-tx broadcast (deploy-app with `customDomain`):** the orchestrated tool itemizes both fees in its plan-elicitation prompt, broadcasts both inside one MCP tool call, and routes partial-success failures through agent-core's recovery dispatch (retry-set-domain / salvage-without-domain / cancel-or-close). Host permission is requested before the outer orchestrated call. Lease creation and domain assignment are separate, sequential transactions; one can succeed while the next fails.

**Known limitation:** `manage-domain` set/clear operations do not refresh
the saved wrapper's `custom_domain` field. Treat it as a historical deployment
snapshot and query the chain for the current assignment via
`mcp__plugin_manifest-agent_manifest-lease__leases_by_tenant` or
`mcp__plugin_manifest-agent_manifest-lease__lease_by_custom_domain`.
Calling `deploy-app` again creates a new lease; it is not a way to refresh
the existing lease's record.

## Saved post-deploy records

Post-ENG-130, agent-core's `saveManifest()` writes the wrapper to `$MANIFEST_AGENT_DATA_DIR/manifests/<lease_uuid>.json` (mode `0600`, parent dir `0700`). The plugin sets `MANIFEST_AGENT_DATA_DIR = $MANIFEST_PLUGIN_DATA` in `start-server.cjs` so the wrapper lands at the same path the plugin's read-only helpers already index — existing v2 + v3 wrappers stay cross-readable.

Wrapper schema v3 (written by agent-core; shape unchanged from pre-rewire): `{ schema_version: 3, lease_uuid, deployed_at_iso, deployed_at_unix, chain_id, image, size, meta_hash_hex, format, manifest_json, custom_domain?, custom_domain_service_name? }`. `manifest_json` is the canonical Fred-rendered string and may contain sensitive env values — skills must NOT pretty-print it unredacted.

MCP 0.22.0's writer does not yet persist compute `sku_uuid` / `provider_uuid`.
The readers accept and surface those optional fields alongside `size` when
present, without requiring a particular schema version. Until the upstream
writer adds them, the selected IDs live in authored drafts and journal
records; the plugin does not edit or supplement the post-deploy wrapper.
Existing v2/v3 output is unchanged when identifiers are absent, and no IDs
are inferred from historical names.

**Read surface (plugin-side, kept per DECISION 2):** `summarize-manifest.cjs` produces a redacted summary (env keys only, FQDN-safe). `list-saved-manifests.cjs` enumerates the wrapper directory for the lease-UUID pickers in `manage-domain` Step 2b and `troubleshoot-deployment` Step 1. Both are consumed by skills via subprocess; skills MUST NOT `Read` or `Write` wrappers directly.

**Write surface:** agent-core owns it. The plugin's old `save-manifest.cjs` + `remove-manifest.cjs` helpers are deleted (DECISION 2 — agent-core's `saveManifest()` and cleanup branch inside `closeLease`'s recovery dispatch cover both).

Saved manifests are historical records; there is no periodic sweep when a lease becomes terminal. Credit exhaustion closes an active lease (`CLOSED`); provider rejection or tenant cancellation while pending produces `REJECTED`; a pending acknowledgement timeout produces `EXPIRED`. Query the current lease state via `app_status`; the wrapper does not track its lifecycle.

### Wrapper schema evolution

When changing the wrapper shape:

- **Writer**: in `manifest-agent-core`'s `internals/save-manifest.js`. Bump there. The plugin doesn't own the writer post-rewire.
- **Readers (plugin-side)**: `summarize-manifest.cjs`, `list-saved-manifests.cjs`. Readers MUST treat unknown-newer wrappers as readable to the extent of their known fields, and missing optional fields as `undefined`.
- **Tests**: `tests/summarize-manifest.test.cjs` is the canonical place to add a fixture asserting the new shape AND a v(N-1) fixture asserting backward read compatibility. Coordinate the bump with the agent-core release.

There is no migration step — the wrapper is a record, not a config file. A v2 wrapper stays v2 on disk forever.

## Operation journal

Every state-changing skill appends one record per invocation to `$MANIFEST_PLUGIN_DATA/journal/<YYYY-MM-DD>.jsonl` (UTC, mode `0600`, parent dir `0700`). Records capture intent, plan summary, tool calls (`args_redacted` per `_journal.cjs#redactArgs`), outcome, errors, recovery actions, and final state. Schema docstring lives at the top of `_journal.cjs`. The skill `/manifest-agent:journal` is the canonical reader.

**Journal names versus host names:** `tool_calls[].tool` retains historical `mcp__manifest-*` identifiers for compatibility with existing records. `_journal.cjs` normalizes callable scoped names to the same reducers, so both forms receive the same redaction. Callable Claude tool names use `mcp__plugin_manifest-agent_manifest-*`. Preserve historical record keys and use the scoped names for invocations; this naming update does not migrate the journal schema.

**Writing**: skills pipe a JSON record to `journal-write.cjs`. The writer auto-fills `timestamp_iso`, `timestamp_unix`, `schema_version`, and `session_id` (from `$MANIFEST_SESSION_ID`); runs `validateRecord` (fail-closed against `SECRET_KEY_DENYLIST` — see below); appends one line via `fs.appendFileSync(... { flag: 'a' })`. Concurrency story: on Linux ext4 / xfs the inode mutex serializes concurrent `write(2)` calls to a regular file, so a record under `MAX_RECORD_BYTES` (4 KiB) appends without interleaving in practice — best-effort, not a POSIX guarantee (`PIPE_BUF` formally applies to pipes / FIFOs only). Records exceeding 4 KiB are replaced with a smaller `journal_truncated` marker so realistic concurrent writes stay in the single-`write(2)` regime and the daily file never carries a torn line.

Every journal-writing workflow uses the shared `workflows/fragments/journal-write.md`
fragment to serialize the complete redacted record with the host Write tool.
It creates a private directory with `mktemp -d` (mode `0700`) and writes a
new filename inside it, then passes the file via stdin redirection. Claude's
Write tool can create the new file without first reading it; a file created
with mode `0644` remains private through its `0700` parent. The workflow
removes both temporary artifacts after the append attempt. Only quoted
temporary paths enter shell source. Redaction removes secret values;
it does not make remaining values such as provider-controlled SKU names
safe to interpolate into a shell command or heredoc.

**Redaction discipline** — same posture as `summarize-manifest.cjs`:
- Env maps render as sorted keys, never values.
- The writer is fail-closed (NOT strip-and-continue): any key in the record tree matching `_journal.SECRET_KEY_DENYLIST` (`mnemonic`, `password`, `private_key`, `secret_key`, `api_key`, `auth_token`, `bearer_token`, all with optional `_`/`-` separators) makes `journal-write.cjs` exit 1 and refuse to append. Skills must redact via `_journal.redactArgs` before piping.
- `manifest_json` is reduced via the in-process `summarizeSpec()` function inside `_journal.cjs` (env keys-only, never values; mirrors the now-deleted standalone `summarize-spec.cjs` script's output shape).
- Lease/SKU/provider UUIDs, addresses, image refs, custom domains, gas-token symbols ARE captured (legitimate non-sensitive blockchain identifiers).
- Deploy reducers retain optional `skuUuid` / `providerUuid` only from each
  tool's accepted input location: `spec` for orchestrated deployment and
  root snake_case fields for direct Fred deployment. Preview has no selectors.
  `_spec.cjs#skuIdentity` trims selector strings and uses a snake_case alias
  only when its camelCase field is absent. Blank/malformed camelCase fields
  suppress their aliases and are omitted, preventing an ignored alias or
  outer field from being journaled as a pin. Storage IDs in skill `final_state` are
  the requested draft identity, not evidence of the deployed lease item's SKU.

**Skills that DON'T write a record**: `manage-domain` lookup sub-flow (dedicated read-only orchestrator), `troubleshoot-deployment` when the user picks "Keep" instead of cleanup (read-only diagnostic — matches pre-rewire posture). The `/manifest-agent:journal` query skill is also read-only.

**Post-ENG-130 fidelity reduction (DECISION 4)**: each state-changing skill now writes ONE `tool_calls[]` entry per orchestrated invocation — the outer `mcp__plugin_manifest-agent_manifest-agent__*_orchestrated` call. The wrapper dispatches multiple inner broadcasts internally (e.g. `deploy_app_orchestrated` calls `cosmos_estimate_fee` + `deploy_app` + maybe `set_item_custom_domain` + `app_status` + cleanup primitives), but these are server-side SDK operations, not nested host MCP tool events. The skill cannot observe or journal them individually through the host hook. The pre-rewire deploy-app record had ~8 inner-tool entries; post-rewire it has 1. The journal still captures intent, plan_summary, outcome, recovery_actions, and a `result_summary` mined from the orchestrated tool's structured return value — sufficient for audit/grep ("what did I deploy on 2026-05-25?"), but coarser than the pre-rewire per-inner-tool trace. The trade-off is deliberate: deeper fidelity would require either (a) embedding `journal_events[]` in agent-core's return values (an upstream change leaking the plugin's `SECRET_KEY_DENYLIST` + record schema across packages) or (b) the wrapper writing directly to `$MANIFEST_AGENT_DATA_DIR/journal/` (which would force the plugin's redaction discipline + schema into the wrapper). Neither is worth the cross-repo coupling.

**Troubleshoot's two-entry exception**: when the user picks cleanup on `troubleshoot-deployment`, the skill makes TWO orchestrated calls in one run — first `mcp__plugin_manifest-agent_manifest-agent__troubleshoot_deployment_orchestrated` (the diagnostic), then `mcp__plugin_manifest-agent_manifest-agent__close_lease_orchestrated` (the cleanup). Per the "one entry per orchestrated invocation" rule, both appear in `tool_calls[]`. This is intentional: the diagnostic call's `result_summary` (the markdown report) is part of the audit trail leading to the close decision. The read-only diagnostic-only path (user picks "Keep") writes no record — matches pre-rewire posture.

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

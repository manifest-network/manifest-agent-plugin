# Testing

Native Codex packaging, concurrent host runtimes, confirmation, cancellation
and the release evidence matrix are covered in
[host-acceptance.md](host-acceptance.md). Build with `npm run build:codex`;
generated Claude skill drift fails the build. `ci/host-contracts.cjs` compares
both real launchers against the installed runtime and tests published callback
contracts offline. `ci/codex-host-smoke.cjs` characterizes the actual Codex
app-server with harmless fixtures; CI pins Codex CLI 0.153.4.
`ci/terminal-host-smoke.cjs` exercises the real terminal interfaces with
scripted keys and local model responses, using Claude Code 2.1.270 or Codex
CLI 0.154.0 plus tmux. It needs no API credentials. Its unit tests run in the
normal suite; the terminal matrix is an explicit local acceptance command.
Live testnet and published-version upgrade evidence remain separate.

This document covers running and adding tests for the manifest-agent plugin. For the higher-level architecture, see [`../CLAUDE.md`](../CLAUDE.md).

## Running tests

The test suite uses `node:test` and `node:assert` and runs with only Node's
standard library (`npm test` needs no runtime packages or `NODE_PATH`).
Runtime support starts at Node 22.19.0. CI tests that exact floor and Node 24
with the tracked MCP 0.22.0 dependency lock.

```bash
# Dependency-free unit suite, inside or outside a host:
npm test

# For installed-runtime checks and executable examples, install the lock
# outside the plugin checkout and point NODE_PATH at it:
INSTALL_DIR="$HOME/.manifest-agent-dev"   # outside the plugin checkout; CI uses $HOME/.manifest-agent
MANIFEST_PLUGIN_DATA="$INSTALL_DIR" node scripts/setup-runtime.cjs
NODE_PATH="$INSTALL_DIR/node_modules" node --test tests/*.test.cjs
```

CI uses the same setup command with `INSTALL_DIR=$HOME/.manifest-agent` (`.github/workflows/ci.yml`). The path differs but the mechanism is identical.

To run a single test file:

```bash
NODE_PATH="$INSTALL_DIR/node_modules" node --test tests/summarize-manifest.test.cjs
```

The installed inventory check and real launcher transport check send only
`initialize` / `tools/list`, using a public fixture wallet and a network-denial
guard. They do not broadcast or contact providers:

```bash
node ci/mcp-tool-policy.cjs --data-dir "$INSTALL_DIR"
node ci/launcher-transport.cjs --data-dir "$INSTALL_DIR"
```

The lease-state parity check reads the installed manifestjs `LeaseState` enum
and compares its numeric chain states with `scripts/_lease-state.cjs`.
It excludes the SDK's `UNRECOGNIZED = -1` sentinel and fails on added,
removed, or remapped states. CI runs it after installing the locked runtime;
the check's unit tests use fixtures, keeping `npm test` independent of the SDK.

```bash
node ci/lease-state-parity.cjs --data-dir "$INSTALL_DIR"
```

The launcher check exercises all five configured servers and verifies strict
JSON-RPC stdout through `start-server.cjs`, including dotenv isolation.
Setup tests cover a fresh install, manifest/lock upgrades, interrupted installs,
missing/truncated dependency files, concurrent setup and stale process locks,
with configuration and saved records preserved. Launcher tests cover chain
switches, omitted optional fields, inherited wallet values and empty passwords.
Startup regressions cover delayed lock creation, missing binaries, all five
concurrent launchers, preserved queued input, bounded failure and SIGTERM.
Lock tests distinguish dead or reused PIDs from live parent/worker processes,
including a ready runtime with a stale lock. Injected-clock tests exercise the
unmodified two-second grace, 25-second launcher bound and 60-second setup bound.
Failure tests verify empty-log cleanup, useful-log retention, distinct completion
diagnostics, native-addon rejection and secret-safe startup errors across phases.
Dangling lock symlinks and repeated lock races must yield to the event loop and
respect setup's deadline. Successful stale-lock recovery stays quiet, and an
expired waiter preserves a stale lock it has not reclaimed. Read-level lock
failures such as EISDIR/EACCES must report their phase and filesystem code
immediately, without claiming that an installer is active.
The SessionStart hook's 90-second timeout retains 30 seconds beyond the default
60-second contention bound. Native-addon checks allow `.node` directory names
and symlinks while rejecting actual `.node` files.

## Test file layout

```
tests/
├── _subprocess.cjs         shared spawnSync helper for CLI-script tests
├── <script>.test.cjs       one test file per script under test
└── _<helper>.test.cjs      one test file per underscore-prefix helper
```

Conventions:

- File name mirrors the script under test: `summarize-manifest.cjs` → `tests/summarize-manifest.test.cjs`. Underscore helpers get an underscore prefix in the test file too: `_io.cjs` → `tests/_io.test.cjs`.
- One `node:test` `test(...)` per assertion or tightly scoped behavior. Group with `describe` only when there's real shared setup; otherwise top-level `test` calls keep the failure output readable.
- Tests should be hermetic: no real network, no real chain RPC, no real disk outside `os.tmpdir()`. Stub by passing fixture data on stdin or via `--*-file` flags pointing at tmpfiles.

## Two flavors of test

### In-process (`require()` the helper directly)

Used for underscore-prefix helpers that export functions. Example: `tests/_uuid.test.cjs` requires `scripts/_uuid.cjs` and calls the exported `isUuid` function. Fast, no subprocess overhead.

### Out-of-process (subprocess via `_subprocess.cjs`)

Used for CLI entry-point scripts where the contract is the stdin/stdout/exit-code envelope. The shared helper at `tests/_subprocess.cjs` exposes:

```js
const { runScript } = require('./_subprocess.cjs');
const result = runScript('journal-write.cjs', ['--dry-run'], JSON.stringify(record));
// result === { status, stdout, stderr, json? }
//   - status: process exit code
//   - stdout / stderr: captured strings
//   - json: parsed stdout if it looks like a single JSON object/array
```

When the script under test emits a single line of JSON, assert on `result.json` directly. When it emits Markdown (renderer scripts), assert on `result.stdout` substrings — but assert only the load-bearing tokens (block headers, field labels), not whitespace or paragraph wording. The latter rots fast.

## Fixtures

Keep small input/output fixtures inline so the assertion stays beside its
input. Shared executable fixtures live in `tests/fixtures/`: JSON-RPC peers,
the harmless native-host MCP server, the Claude MCP fixture, and the local
terminal model driver. CI syntax-checks these files. Extract a separate
fixture when multiple tests or host harnesses need the same behavior.

## Writing a new test

When adding a new script, add a test file in the same commit. Skipping tests for "obvious" scripts is fine ONLY for renderer scripts whose output is wholly determined by their flags (e.g. a wrapper that prints a static string). Anything that parses input, classifies, validates, or branches needs at least one test per branch.

Branch coverage checklist for a new test file:

- [ ] Happy path (canonical input → expected output)
- [ ] Each error/exit path the script can take (missing flag, invalid JSON, schema violation, etc.)
- [ ] Each enumerated output classification, if the script is a classifier (e.g. a hypothetical readiness evaluator with `ok` / `warn` / `block`; or `_journal.cjs#redactArgs`'s seven per-tool branches)
- [ ] Boundary conditions for any threshold the script enforces (e.g. gas-price floor, FQDN length cap)

For schema-evolving wrappers (the post-deploy wrapper file written by `manifest-agent-core`'s `saveManifest()` and read by `summarize-manifest.cjs` / `list-saved-manifests.cjs`), include both:

- A v(N) fixture asserting the new shape works.
- A v(N-1) fixture asserting the reader still loads it (missing fields render as undefined, not throw).

ENG-260 reader fixtures also exercise optional `sku_uuid` / `provider_uuid`
without requiring a schema bump, including names repeated across providers
and within one provider. MCP 0.22.0 still writes v3 wrappers without these
fields; the newer fixtures test reader compatibility, not upstream persistence.
Draft save/env-merge tests verify compute selectors and storage identity
metadata survive unchanged. ENG-117 cases also preserve full digest-pinned
references in one-service maps and legacy specs, plus a stack mixing a
registry port/tag-plus-digest reference and explicit or implicit mutable tags.
The installed-runtime `ci/host-contracts.cjs` check verifies exact per-service
image preservation in the published manifest builder and MCP deploy handler.
Its deployer is injected: this covers forwarding, not registry resolution or
provider upload. Those behaviors and the canonical digest recap require
the upstream [ENG-954](https://linear.app/liftedinit/issue/ENG-954) contract.
Image-reference tests reject malformed digest syntax, preserve complete
references, and ensure the draft saver refuses malformed digests before
writing. Integration cases execute the generated authoring and deployment
shell checks on both hosts with valid and hostile malformed inputs, verifying
full output, exit status, unchanged files, and no env-value disclosure or shell
execution. They exercise the script calls, not a model's prompt choices or
final prose; those remain a behavioral host-testing concern.
Storage-check tests reject a changed UUID or
ambiguous same-provider name while allowing the same name on another provider.
They execute the deploy skill's documented shell command with a serialized
catalog file containing quotes, backslashes, a heredoc delimiter, and shell
syntax in a SKU name. The check must preserve that name, leave the original
spec unchanged, omit its env values, and execute no catalog-supplied commands.
Journal tests also reject ignored selector locations and aliases suppressed
by empty camelCase fields, matching the pinned MCP contract.
The journal-write integration test executes the deploy skill's journal
command with a serialized record containing the same hostile SKU-name
patterns. It verifies literal preservation, no shell execution, and no
environment secret in the journal or command output.

## Secret-input recipe regressions (ENG-1010)

`tests/build-packages.test.cjs` checks that every generated secret-file recipe
has adjacent advice to start `bash` from fish and stay in that session through
cleanup, with Bash started before the recipe commands. Generated workflows
must not name `exec_command` as a session, shell or terminal. That three-noun
check does not cover every possible shell reference; the broader renderer
fix is tracked in [ENG-1029](https://linear.app/liftedinit/issue/ENG-1029).
For `init-agent` and `import-key`, source and render guards reject negated
read/shell tool instructions, including an intervening verb or line break,
while allowing advice about the lowercase `bash` shell.

`tests/merge-env.test.cjs` checks both hosts' generated env recipes and the
README: the capture block ends at `cat`, data-entry and Enter/Ctrl+D guidance
sits between blocks, and path display follows the returning shell prompt.
It executes the commands with harmless stdin fixtures, checking mode `0600`,
exact input contents, and no values in output. Generated merge commands must
preserve values and private spec permissions. Empty and comment-only inputs
exercise the helper's `keys_merged: []` response and the workflow's stop/retry
instruction; these assertions do not execute a model's recovery decision.
Cleanup cases provide confirmed recipe-created paths,
including spaces, apostrophes and shell syntax, while `ENV_INPUT_PATH` refers
only to the last file. Those temporaries must be removed while supplied
pre-existing and unknown-origin dotenv files remain byte-identical after
merge and cleanup. The fixture supplies each file's origin; it does not test
a model's provenance decision. No path contents may execute.

`tests/workflow-config.test.cjs` also executes both hosts' separated mnemonic
capture and path-display blocks and requires the words-only, waiting-terminal,
Enter/Ctrl+D and returning-prompt instructions between them. The input file
must contain only the supplied words, at mode `0600`, with no instructional
comments or mnemonic output.
These fixtures supply the choices and paths; they do not establish interactive
model behavior.

```bash
node --test tests/build-packages.test.cjs tests/merge-env.test.cjs tests/workflow-config.test.cjs
```

## Wallet gas-setting regressions (ENG-1009)

`tests/workflow-config.test.cjs` executes both hosts' generated wallet pipelines,
status commands and journal commands. Only the cryptographic key
generation/import boundary is replaced with disposable wallet fixtures; config
writes, file credentials and journals use the real scripts. Both `init-agent`
paths and standalone `import-key` cover integer/fractional/numeric-string
multipliers, absent/null defaults, and a new invocation after an interruption
immediately following the config write. Assertions inspect the saved multiplier
before any follow-up command, and require final status to follow each wallet
pipeline without a separate gas mutation. Initial setup and cancellation before
or after status are covered for both `init-agent` paths. An unreadable config
exercises partial reporting with the confirmed identity and unknown gas settings,
followed by recovery using only status. Journal fixtures instantiate the shipped
sketches for success, partial, recovered and cancelled outcomes, checking the
chain/signer schema, structured errors and private staging cleanup.

`tests/write-config.test.cjs` directly checks immediate and repeated preservation,
legacy credential migration, and failed replacement. Injecting failure at the
atomic rename leaves the previous wallet and multiplier together; retrying the
writer with the same retained key succeeds without generating another wallet.

```bash
node --test tests/workflow-config.test.cjs tests/write-config.test.cjs tests/update-config.test.cjs tests/build-packages.test.cjs
```

These offline Linux regressions verify the commands and journal data contract.
The test driver supplies choices, recovery decisions and sketch values; it does
not establish a model's prompt handling, outcome classification or final prose.
Those still require fresh behavioral host acceptance before release.

## Config-update recovery regressions (ENG-1011)

`tests/update-config.test.cjs` reproduces refresh without an active chain and
gas-token selection with metadata only in config. Both current and legacy
configs retain their exact bytes and release the lock on refusal. Fixtures
execute the suggested chain choices and fetch/retry commands for each network,
using the real fetcher with only HTTPS replaced. A partial fetch of the other
network must leave gas-token selection blocked; successful recovery preserves
the wallet and applies the requested gas flags. Disk metadata remains the
source for gas-token prices; stale config must first be synchronized and its
token choices reviewed. Cases cover malformed files and config maps, offline
recovery using existing files, preservation of the active network during repair,
and a single file snapshot for combined gas/refresh updates.
`tests/workflow-config.test.cjs` executes both hosts' generated gas commands:
the displayed registry price must match the saved price, and a subsequent
disk change must refuse the update until synchronization and a new choice.

```bash
node --test tests/update-config.test.cjs tests/write-config.test.cjs tests/_gas-price.test.cjs tests/workflow-config.test.cjs
```

## Registry metadata regressions (ENG-1008)

`tests/_chain-registry.test.cjs` runs the full malformed-metadata matrix in
process: response shapes, chain-ID syntax, RPC/REST endpoint policy, fee-token
structure, denominations and minimum/optional gas prices. It checks local HTTP,
HTTPS, scheme normalization, first-entry selection, optional fields, and gas
composition after a JSON cache round trip.

`tests/fetch-chain-registry.test.cjs` replaces only the HTTPS boundary and keeps
35 subprocess cases for persistence and failure handling. Representative
malformed inputs fail mainnet, testnet, and both networks in turn. Assertions
check stdout, status, network/field diagnostics, cached bytes, saved files,
and timestamp advancement/preservation. Transport/write failures, optional
asset failure and timestamp-write failure remain covered. Config-writer tests
prove an old null minimum price cannot replace an existing config.

```bash
node --test tests/_chain-config.test.cjs tests/_chain-registry.test.cjs tests/_gas-price.test.cjs tests/fetch-chain-registry.test.cjs tests/chain-config-parity.test.cjs
```

After locked runtime setup, CI runs the following offline consumer check:

```bash
node ci/chain-config-parity.cjs --data-dir "$INSTALL_DIR"
```

It compares endpoint, chain-ID and gas-price predicates with the installed
MCP core using shared vectors, then feeds extracted/persisted metadata and
composed gas prices through upstream startup validation. Unit tests inject
policy drift to ensure the check fails. Registry shape/spelling checks are
intentionally stricter than the upstream string predicates. No endpoint
probes or transactions are performed.

These Linux checks do not replace source-bound host acceptance or establish
native macOS/Windows compatibility. See [the plan](eng-1008-plan.md) and
[release evidence requirements](host-acceptance.md#release-evidence).

## Exercising scripts manually

Useful for debugging without standing up a full Claude session.

The shell examples below are each self-contained and tagged for the
executable-docs check (`npm run test:docs` — see "Executable doc examples
(docs-ci)" further down). Under that check every tagged block runs in its
own isolated tempdir: the harness points `MANIFEST_PLUGIN_DATA` at a fresh
dir pre-seeded with a minimal `chains/testnet.json`, inherits `NODE_PATH`,
and runs from the repo root. Run the one-time setup yourself only when
exercising the commands by hand.

### One-time setup

<!-- docs-ci network -->
```bash
export MANIFEST_PLUGIN_DATA="${MANIFEST_PLUGIN_DATA:-$HOME/.manifest-agent-dev}"
node scripts/setup-runtime.cjs || exit
export NODE_PATH="${NODE_PATH:-$MANIFEST_PLUGIN_DATA/node_modules}"
printf 'Runtime ready: %s\n' "$MANIFEST_PLUGIN_DATA"
```

### Fetch chain registry

<!-- docs-ci network expect="mainnet" expect="testnet" -->
```bash
node scripts/fetch-chain-registry.cjs
```

### Generate and configure a test key

`gen-agent-key.cjs` mints a fresh 24-word wallet, encrypts it under a
randomly generated password, and prints `{ address, keyfile, password,
agentId }` as JSON on stdout (all human-readable logs go to stderr). It
writes the encrypted keyfile under `$MANIFEST_PLUGIN_DATA/keys/`. Pipe its
output directly into `write-config.cjs` so the password does not appear in
terminal output or captured logs. Fetch chain data first when running this
example manually. Use only a disposable developer data directory: this
command selects a new wallet in its config.

This example explicitly selects private-file credential storage for a
headless test environment. For native credential storage, follow
[identity setup](identity.md).

<!-- docs-ci -->
```bash
node scripts/gen-agent-key.cjs --prefix manifest |
  MANIFEST_CREDENTIAL_STORE=file node scripts/write-config.cjs --chain testnet --gas-price 1umfx
```

### Render a balance report

A fixture `credit_balance` response. The fixture keys match the actual
payload `render-balance.cjs` reads: `balances` (wallet),
`credits.{balances,available_balances}` (gross + net credit),
`current_balance` (live estimator), `spending_per_hour`, `running_apps`,
`hours_remaining`. Note that `running_apps` and `hours_remaining` are
STRINGS in the live-estimator response shape (see `scripts/render-balance.cjs`)
— passing them as numbers, or using the wrong top-level keys, silently
degrades the rendered output to "(unavailable)" rather than erroring. That
exact drift (wrong payload keys) is what PR #9's R4b review caught; the
`expect-not="(unavailable)"` (credit-key drift) and `expect-not="(empty)"`
(wallet-key drift) directives on this block are what now catch it in CI.
(Caveat: `expect-not="(empty)"` assumes this funded-wallet fixture; if you
copy the block to demonstrate an empty wallet, drop that directive or it
will false-RED.)

<!-- docs-ci expect="MFX" expect-not="(unavailable)" expect-not="(empty)" -->
```bash
echo '{
  "balances": [{ "denom": "umfx", "amount": "1000000" }],
  "credits": {
    "balances": [{ "denom": "umfx", "amount": "5000000" }],
    "available_balances": [{ "denom": "umfx", "amount": "4500000" }]
  },
  "current_balance": [{ "denom": "umfx", "amount": "4500000" }],
  "spending_per_hour": [{ "denom": "umfx", "amount": "10000" }],
  "running_apps": "1",
  "hours_remaining": "450"
}' | node scripts/render-balance.cjs \
      --address manifest1abc \
      --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/testnet.json"
```

### Append a fixture journal record

Uses `--dry-run` to print the record that *would* be appended without
touching disk.

<!-- docs-ci -->
```bash
echo '{
  "skill": "set-gas-price",
  "active_chain": "testnet",
  "signer_address": "manifest1abc",
  "intent": "test record",
  "plan_summary": "smoke",
  "tool_calls": [],
  "outcome": "success",
  "final_state": {},
  "errors": [],
  "recovery_actions": []
}' | node scripts/journal-write.cjs --dry-run
```

### Test an MCP wrapper end-to-end

Requires initialized config, its encrypted wallet and accessible credential
storage. Each command starts a stdio JSON-RPC server and waits for a client;
it does not itself send a request. Run one at a time, or use
`ci/launcher-transport.cjs` above for an automated offline transport check.
These commands are intentionally not tagged for docs-ci.

```bash
node scripts/start-server.cjs chain
node scripts/start-server.cjs agent   # ENG-130 5th server
```

## Testing the orchestrated flow

Post-ENG-130 most orchestration logic lives in `@manifest-network/manifest-agent-core` (in the [`manifest-mcp-mono`](https://github.com/manifest-network/manifest-mcp-mono) repo, not this plugin). Plan rendering, fee itemization, classification, partial-success recovery, and verify-and-recover dispatch are all upstream. The plugin's tests cover only what stays here:

- `tests/start-server.test.cjs` — the wrapper's env-var contract for the 5th server (`agent`), including the new `MANIFEST_AGENT_DATA_DIR` / `MANIFEST_CHAIN_DATA_FILE` / `MANIFEST_AGENT_FETCH_GUARDED` env vars.
- `tests/_journal.test.cjs` + `tests/journal-write.test.cjs` — `redactArgs` reducers for the four orchestrated tools (`deploy_app_orchestrated`, `manage_domain_orchestrated`, `troubleshoot_deployment_orchestrated`, `close_lease_orchestrated`) plus the secret-key denylist + integration round-trip.
- `tests/session-start.test.cjs` — the runtime policy heredoc references the orchestrated tools as the canonical confirmation surface (no longer mentions `render-deployment-plan.cjs` / `format-success.cjs`).
- All read-only renderers (`tests/render-{balance,providers,releases}.test.cjs`), the journal (`tests/_journal.test.cjs`, `tests/journal-{read,write}.test.cjs`), the I/O primitives (`tests/_io.test.cjs`, `tests/_uuid.test.cjs`), the spec helpers (`tests/_spec.test.cjs`), the env merge (`tests/merge-env.test.cjs`), and the saved-manifest summarizer (`tests/summarize-manifest.test.cjs`).

For the orchestrator's own tests, see `manifest-mcp-mono`. This repository
also exercises its published callback contracts with `ci/host-contracts.cjs`.
Live host/chain/provider acceptance is a separate, funded run described in
[host-acceptance.md](host-acceptance.md); it is required for the current
version's Codex release archive, not for ordinary unit-test runs.

## Doc/code drift checks

Two CI checks (ENG-213) close the doc-vs-code drift class that repeated
Copilot review rounds caught on PR #9 — cases where the docs said X but the
code did Y, which structural review didn't surface. They live in `ci/` (not
`scripts/`, since they're CI tooling rather than plugin runtime) and each
ships with a demonstrated-drift unit test under `tests/` that proves the
check actually fires on the bug class it targets (ENG-214 principle #2 — a
guard you haven't watched fail is not yet a guard).

### Executable doc examples (docs-ci)

`ci/docs-ci.cjs` runs the shell examples in a Markdown file that are
explicitly tagged for it and asserts they behave as documented. This catches
the R4b drift class: an example using the wrong payload keys still exits 0
but renders "(unavailable)" — invisible to an exit-code-only check.

**Tagging.** A block is opted in by an HTML comment on its own line at column
0 (invisible in rendered Markdown, but grep-able with `grep -n docs-ci
docs/testing.md`). The comment's next non-blank line MUST open the fence:

    <!-- docs-ci expect="MFX" expect-not="(unavailable)" -->
    ```bash
    echo '{ ... }' | node scripts/render-balance.cjs ...
    ```

(The column-0 / whole-line rule is why this indented illustration isn't
itself executed.)

**Directive grammar:**

- `<!-- docs-ci -->` — marker; run the next fence.
- `network` — skip unless `DOCS_CI_RUN_NETWORK=1`. Inventoried-but-skipped:
  the block still shows as `SKIP` in the output, documenting intent rather
  than silently omitting it. Used for the locked runtime setup and the
  chain-registry fetch.
- `expect="<substr>"` — repeatable; stdout MUST contain it.
- `expect-not="<substr>"` — repeatable; stdout MUST NOT contain it.
- `allow-nonzero` — don't fail on a nonzero exit (for examples that
  deliberately demonstrate errors).
- Default (no `expect` / `expect-not`): assert exit 0 AND non-empty stdout.

An unknown directive token (e.g. a typo like `expct=`) throws, so a mistagged
block fails loudly instead of silently degrading to default mode.

**Execution flags.** Blocks run under `bash -e -o pipefail` (a per-block 120s
timeout also applies), so a mid-block failure — an earlier command, or a
non-final pipeline stage — fails the block instead of being masked by a
later command that happens to succeed. `-u` (nounset) is deliberately NOT
set: examples legitimately use `${VAR:-default}`. For an example that
intentionally tolerates a nonzero exit, use the `allow-nonzero` directive as
the escape valve.

**Isolation.** Each block runs in its own fresh tempdir:
`MANIFEST_PLUGIN_DATA` points at it, pre-seeded with a minimal
`chains/testnet.json` (so `render-balance.cjs` resolves denom symbols
offline); `NODE_PATH` is inherited from the environment; cwd is the repo root
(so `node scripts/...` resolves). The tempdir is removed after each block.
Per-block, not shared — the same hermetic posture as the unit tests.

**Running locally:** `npm run test:docs`. CI sets `NODE_PATH` to the install
dir; locally you need the runtime deps installed and `NODE_PATH` exported per
the "One-time setup" block above (the `render-balance` example resolves
`./humanize-denom.cjs`; `gen-agent-key` needs `@cosmjs/proto-signing`).

**Adding a new tagged example:**

1. Make the block self-contained and hermetic — it must run with only the
   seeded `MANIFEST_PLUGIN_DATA` and inherited `NODE_PATH`, no network, no
   reliance on a prior block's state. Tag network/install-dependent blocks
   `network`.
2. Choose directives that assert the *behavior the doc claims*, not just
   "it ran" — prefer `expect=` / `expect-not=` over the default mode when the
   rendered output is the point.
3. **RED-GREEN it before trusting it.** Mutate the underlying code or the
   example so the documented behavior breaks, confirm `npm run test:docs`
   fails with a clear message, then revert. A directive you haven't watched
   fail is not yet a guard (ENG-214 principle #2; the full principle lands in
   ENG-214). `tests/docs-ci.test.cjs` pins this for the harness itself.

`docs/scripts.md` has no copy-pasteable examples today, so it isn't targeted;
the harness is file-parameterized (`node ci/docs-ci.cjs <file>`) and can
target it later.

### PreToolUse policy completeness

`ci/policy-completeness.cjs` checks that the runtime policy and developer
list agree with the hook matcher. This is a documentation-consistency
check, not evidence that Claude intercepted a call.

Both policy checks use `matcherNames` from `ci/mcp-tool-policy.cjs` to
require exact, individually anchored, unique tool names. The local check
rejects permissive regexes and malformed matchers without installing or
starting the MCP servers.

**What it asserts:**

1. **session-start.sh naming** — every matcher-gated tool is named in the
   runtime-policy heredoc, by its full scoped name or a bounded short name.
   A mention of `deploy_app_orchestrated` must not accidentally count as a
   mention of `deploy_app`.
2. **CLAUDE.md gated-tools list parity** — the "Tools gated by the PreToolUse
   hook" bullet list must set-equal the matcher. Read-only exceptions are
   explained outside the list; a missing heading fails the check.
3. **Installed inventory validation** — `ci/mcp-tool-policy.cjs` separately
   discovers tools from every server in `.mcp.json` using the installed,
   pinned package. It initializes the servers and requests `tools/list`,
   then checks published mutation metadata against the scoped matcher.
   Metadata is checked for validity and consistency; source review is
   still required to detect a handler that misreports its side effects.
   The workflow does not keep a duplicate expected-name list or assert
   that mutating orchestrators must be absent from the matcher.

**Why `docs/scripts.md` is exempt:** it cross-references the CLAUDE.md list
rather than enumerating the tools, so there's nothing to set-compare. This is
the documented reason it's outside the automated check, not a silent
omission.

**Allowlist contract.** `ALLOW_MISSING_FROM_POLICY` (a constant in the script
header) carves out assertion 1 *only* — for a gated tool legitimately covered
by cross-reference rather than a direct mention. It starts empty (all gated
tools are named on baseline). Each entry is `{ tool: '<short_name>', reason:
'<non-empty justification>' }`. The check is strict (anti-lying-guard): a
reasonless entry, an entry for a tool not in the matcher, and a dead entry
for a tool that *is* named are all CI failures. To add an exception, add the
entry with a real reason; once the tool gets a direct mention, CI tells you
to remove the now-stale entry. Assertion 2 (the CLAUDE.md list) has no
allowlist — it must match exactly.

**Running locally:** `npm run test:policy-completeness` needs no installed
runtime dependencies. After installing the pinned runtime dependencies,
run `node ci/mcp-tool-policy.cjs`; use `--data-dir <install-directory>`
when those dependencies live outside the repository. The inventory check
uses synthetic test credentials and makes no live chain/provider calls.

### Actual Claude-host characterization

Run `node ci/claude-hook-smoke.cjs` when Claude is installed and the
environment permits loopback sockets. It uses an isolated configuration
and local fixture API/MCP servers. This is a separate host check, not part
of the standard CI unit suite. Read [`approval-validation.md`](approval-validation.md)
for the recorded version, observed behavior, and the separate four-case
native terminal validation. That terminal record used automated keystrokes;
this stream-control harness does not itself exercise the terminal UI.

## What CI runs

`.github/workflows/ci.yml`:

1. `node --check` syntax check on every `scripts/*.cjs`, `ci/*.cjs`, and `tests/fixtures/*.cjs`.
2. `bash -n` syntax check on every `scripts/*.sh`.
   `ci/check-powershell.ps1` also parses `scripts/*.ps1` and `ci/*.ps1` without
   invoking Windows APIs; its regression test rejects deliberately malformed syntax.
3. `JSON.parse` on every tracked `.json` file.
4. Version consistency: `package.json`, `.claude-plugin/plugin.json`,
   `hosts/codex/manifest-agent/.codex-plugin/plugin.json`, and the lockfile's
   root package version must match.
5. Installed MCP tool inventory: `ci/mcp-tool-policy.cjs` discovers the actual tools published by all configured servers, checks metadata and anchored scoped matcher coverage, and preserves the explicit read-only/testnet-faucet exceptions. It sends initialization and `tools/list` requests only, using an isolated synthetic signer fixture with outbound network operations blocked. It never invokes a transaction or provider tool.
6. PreToolUse policy completeness (`npm run test:policy-completeness` → `ci/policy-completeness.cjs`): every matcher-gated tool is named in the `scripts/session-start.sh` runtime policy (the R3 fix), AND the `CLAUDE.md` "Tools gated by the PreToolUse hook" list set-equals the matcher (principle #6). See "Doc/code drift checks" above for the matching contract and allowlist rules.
7. SessionStart policy: `bash scripts/session-start.sh` must produce non-empty stdout that contains `cosmos_estimate_fee`.
8. MCP binary presence: `manifest-mcp-{chain,lease,fred,cosmwasm,agent}` are installed and executable.
9. `NODE_PATH` resolution: `@cosmjs/proto-signing` is reachable from the install dir.
10. Unit tests: `node --test tests/*.test.cjs`. Post-ENG-130 the suite covers wrapper plumbing (`tests/start-server.test.cjs` — env-var contract for all five servers including `agent`), the journal layer (`tests/_journal.test.cjs` + `tests/journal-{read,write}.test.cjs` — including the four new orchestrated-tool reducers), the read-only renderers, the env merge, the saved-manifest summarizer, and the two drift-check harnesses (`tests/docs-ci.test.cjs`, `tests/policy-completeness.test.cjs` — the demonstrated-drift proofs). Orchestration logic itself (plan rendering, classification, recovery dispatch) is tested upstream in `manifest-mcp-mono`.
11. Real launcher transport: `ci/launcher-transport.cjs --data-dir "$INSTALL_DIR"` initializes all five published servers through the shipped launcher with an encrypted public fixture wallet and outbound networking blocked.
12. Executable docs (`npm run test:docs` → `ci/docs-ci.cjs docs/testing.md`): runs the `docs-ci`-tagged shell examples and asserts their `expect`/`expect-not` directives hold. Runs after the runtime-deps install so `NODE_PATH` resolves. See "Doc/code drift checks" above.

CI also builds the generated Claude/Codex packages, validates historical
evidence provenance and release-row status/schema, checks installed lease-state
parity and both-host callback contracts, and uploads the Codex package. A
separate job installs Codex 0.153.4, runs the eight app-server fixture cases,
and validates their fresh report against the checkout. It does not run the
interactive terminal or funded testnet matrix. The main job runs on Node
22.19.0 and Node 24.

When the published MCP surface changes, review the installed-inventory check, hook matcher, runtime policy, and `CLAUDE.md` gated-tool list together. Policy parity, package discovery, local hook tests, and actual Claude-host behavior establish different things; see [`approval-validation.md`](approval-validation.md).

### Host evidence provenance

Run `node ci/evidence-check.cjs` to verify that current host evidence hashes
match the hook and fixture sources. Re-run the isolated host checks when those
sources change; replacing hashes alone is not validation. Historical evidence
is explicitly tied to its original commit. A shallow clone may lack that
commit; the check then reports metadata-only verification for that historical
record. Use `--require-history` when its original commit is available to require
verification of the historical bytes too.

`tests/evidence-check.test.cjs` exercises source drift, missing/malformed
metadata, historical commit mismatches, and unavailable-history behavior.

## Identity hardening checks (ENG-85)

`tests/_credentials.test.cjs` and `tests/migrate-credentials.test.cjs` exercise
native command contracts, verified storage, permissions, secret-safe errors,
legacy migration and concurrent callers. Native commands are replaced with
isolated fakes; they never access a developer's keychain. The config-writer and
launcher tests use explicit file storage and verify that config contains only a
reference and that startup receives the expected password. Invalid JSON must
not leak parser excerpts containing secrets.

Review regressions cover validation-error lock release, Linux PID reuse, guarded
stale-lock recovery, concurrent updates on the test temporary filesystem, and a
single timed-out native helper attempt shared by automatic migration callers.
The concurrency regression has also been run on btrfs; see the recorded plan.
Set `MANIFEST_LOCK_TEST_ROOT` to an existing scratch directory on the filesystem
being checked when running `tests/_credentials.test.cjs`; it defaults to the
system temporary directory and does not detect the filesystem type.
Damaged previous configs
retain their exact bytes and report private repair/backup steps. Launchers reject
config changes during migration, and failed storage identifies the retained
encrypted keyfile. The real Codex smoke starts from legacy config and asserts
environment forwarding and migration for every server, plus config, wallet and
credential preservation across reinstall.

Retry tests distinguish automatic startup pauses from immediate manual/config
writer retries, and confirm validation errors retain their specific diagnostics.
All five launcher paths are tested against one failed native helper attempt;
disabling the launcher's cooldown makes that regression fail. Corrupt existing
entries do not pause automatic retries, while fresh-store verification failures
do. Dangling recovery-guard symlinks receive path-specific access diagnostics.
Lock timeouts distinguish active contention from abandoned recovery without
removing any guard. Writer tests preserve keyfiles and report the cause first,
including failures before credential storage.

`tests/session-identity.test.cjs` drives a mock MCP peer through initialization
and the bank/balance query, including zero/funded/mainnet balances, exact
threshold arithmetic, malformed replies, deadlines and stdout isolation.
Hook tests parse structured output and verify the complete policy and safe report
reach both context and user-message fields, including migration failures. Source
gating covers startup, resume, clear, compact and fork; cleanup tests reproduce a
peer whose EOF handler would swallow TERM. PowerShell transport tests read a
Unicode request under a simulated ASCII console without running Windows APIs.
Reporter-process crashes, partial/invalid output, noisy Node wrappers and closed
stdin retain the complete policy; successful report output remains valid JSON.
CommonJS helper tests cover module-input `NODE_OPTIONS`, wrappers that drop extra
descriptors, exit-time preload banners and relative plugin roots. Report validation
tests reject extra keys, wrong event names, missing policy, invalid message types
and oversized context/message strings before any report is published.
Dispatch tests intercept `Add-Type` and prove ACL/invalid operations skip it,
including mutations that incorrectly hoist compilation before validation.
These are protocol and behavior tests, not a live RPC or desktop UI acceptance
record. An isolated Linux D-Bus/GNOME Keyring session additionally verified actual
libsecret storage, readback and migration. Native macOS Keychain and Windows
Credential Manager round trips, migration and Windows ACL behavior remain
untested; platform access is unavailable for the 0.5.0 release preparation.
Record those limits in the release notes and do not claim native acceptance
on those platforms. Linux CLI acceptance separately checks the host's startup
report. The previous 0.4.0 host reports remain historical evidence.

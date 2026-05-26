# Testing

This document covers running and adding tests for the manifest-agent plugin. For the higher-level architecture, see [`../CLAUDE.md`](../CLAUDE.md).

## Running tests

The test suite uses `node:test` and `node:assert` — no framework dependency.

```bash
# Inside Claude Code, with deps already installed in $MANIFEST_PLUGIN_DATA:
npm test

# Outside Claude Code, where SessionStart hasn't run, install deps to a
# scratch dir and point NODE_PATH at it:
INSTALL_DIR="$HOME/.manifest-agent-dev"   # any writable path; CI uses $HOME/.manifest-agent
mkdir -p "$INSTALL_DIR"
cp package.json "$INSTALL_DIR/"
npm install --omit=dev --prefix "$INSTALL_DIR"
NODE_PATH="$INSTALL_DIR/node_modules" node --test tests/*.test.cjs
```

CI does the same dance with `INSTALL_DIR=$HOME/.manifest-agent` (`.github/workflows/ci.yml`). The path differs but the mechanism is identical.

To run a single test file:

```bash
NODE_PATH="$INSTALL_DIR/node_modules" node --test tests/summarize-manifest.test.cjs
```

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

There is no `tests/fixtures/` directory. Fixtures are inlined as JS literals in each test file. Two reasons:

1. The shapes are small (most fit on one screen).
2. Inlining keeps the assertion adjacent to the input, which makes failures debuggable without flipping between files.

If a fixture grows large enough that this trade-off flips (more than ~50 lines, or shared by 3+ tests), promote it to a top-level `const FIXTURE = ...` in the test file. Don't extract to a separate file unless the same fixture is needed by multiple test files.

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

## Regression tests for documentation invariants

A regression test that exists but doesn't fire on its negative-injection check manufactures false confidence — reviewers (human + AI) treat it as a guard when it isn't one. This is principle #2 in [`../CLAUDE.md`](../CLAUDE.md) "Review-discipline hindsight" and the most common failure mode caught by Copilot review on this repo. The drift-guard recursion corollary (a tool that catches drift can itself drift) compounds it: every drift guard needs its own drift guard.

**Red-green before trusting.** Every regression test must be watched fail on the exact bug it claims to catch before merging:

1. Inject the mutation the test is meant to catch (revert the fix, flip an enum value, drop a directive).
2. Run the test; confirm it fails with a message that names the violated invariant.
3. Revert; confirm it passes.
4. Commit the test with a commit body that names the mutation it was red-green'd against, so a future contributor can audit the guarantee.

**Worked examples from ENG-213** (`tests/docs-ci.test.cjs` + `tests/policy-completeness.test.cjs`):

- **Zero-blocks lying-green.** `ci/docs-ci.cjs` originally exited 0 when `extractBlocks` returned `[]` — the drift guard had its own drift-failure mode for the empty-input case. Caught by Copilot R3 on PR #10. Fix added a fail-fast assertion + a regression test red-green'd against the mutation. Commit `0f1865c`.
- **`set -e`/`pipefail` lying-green.** Blocks ran via `bash -c` without `-e -o pipefail`, so a multi-command block where an earlier command failed and the last succeeded exited 0 — docs-ci lied green. Caught by Copilot R4. Fix added the shell flags + two regression tests (`false\necho done` and `nonexistent | cat`) each independently red-green'd. Commit `e5008ed`.
- **Empty `expect=""` lying-green.** `parseDirectives` allowed `expect=""` to parse to empty string; `stdout.includes("")` is always true → directive always satisfied. Caught by Copilot R5. Fix rejects empty / whitespace-only values at parse time + regression test red-green'd. Commit `8ce1595`.
- **Planning-time two-step lying-guard near-miss.** Architect's first matching-strategy proposal for the `policy-completeness` check (word-boundary regex on short tool names) would have *false-RED'd* `deploy_app` — `_` is a regex word char, so `\bdeploy_app\b` doesn't match inside `mcp__manifest-fred__deploy_app`. The obvious next move under that failure (loosening to plain substring on short names) is the lying-green trap: `deploy_app` matches inside `deploy_app_orchestrated`, silently approving a bad enumeration. Coordinator caught the two-step trap pre-implementation by empirically running each candidate regex against the corpus, pinned the correct contract (full-name-substring OR snake-token-bounded short), and the regression test now meta-verifies by breaking the regex in both directions.

The discipline applies to any test whose purpose is to *prevent* a class of bug, not just doc-drift checks. If the test wouldn't fire on the bug it claims to catch, it's a lying guard regardless of domain.

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
mkdir -p "$MANIFEST_PLUGIN_DATA"
cp package.json "$MANIFEST_PLUGIN_DATA/"
npm install --omit=dev --prefix "$MANIFEST_PLUGIN_DATA"
export NODE_PATH="${NODE_PATH:-$MANIFEST_PLUGIN_DATA/node_modules}"
```

### Fetch chain registry

<!-- docs-ci network -->
```bash
node scripts/fetch-chain-registry.cjs
```

### Generate a key

`gen-agent-key.cjs` mints a fresh 24-word wallet, encrypts it under a
randomly generated password, and prints `{ address, keyfile, password,
agentId }` as JSON on stdout (all human-readable logs go to stderr). It
writes the encrypted keyfile under `$MANIFEST_PLUGIN_DATA/keys/`.

<!-- docs-ci -->
```bash
node scripts/gen-agent-key.cjs --prefix manifest
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

Requires a real `config.json` and blocks on the spawned MCP server, so it
is intentionally NOT tagged for docs-ci.

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

For end-to-end exercise of the orchestrated flow itself, see `manifest-mcp-mono`'s test suite. A live testnet smoke run from this plugin is in scope for ENG-130 #18 but optional pending wallet/credit availability.

## Doc/code drift checks

Two CI checks (ENG-213) close the doc-vs-code drift class that repeated
Copilot review rounds caught on PR #9 — cases where the docs said X but the
code did Y, which structural review didn't surface. They live in `ci/` (not
`scripts/`, since they're CI tooling rather than plugin runtime) and each
ships with a demonstrated-drift unit test under `tests/` that proves the
check actually fires on the bug class it targets (a guard you haven't
watched fail is not yet a guard — see [`../CLAUDE.md`](../CLAUDE.md)
"Review-discipline hindsight" principle #2).

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
  than silently omitting it. Used for the `npm install` setup and the
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
   fail is not yet a guard — see [`../CLAUDE.md`](../CLAUDE.md)
   "Review-discipline hindsight" principle #2 and the "Regression tests for
   documentation invariants" section above for the worked examples.
   `tests/docs-ci.test.cjs` pins this for the harness itself.

`docs/scripts.md` has no copy-pasteable examples today, so it isn't targeted;
the harness is file-parameterized (`node ci/docs-ci.cjs <file>`) and can
target it later.

### PreToolUse policy completeness

`ci/policy-completeness.cjs` treats the `hooks/hooks.json` PreToolUse matcher
as the source of truth and asserts the gated-tool enumeration hasn't drifted
across the sites that restate it. It closes the R3 gap (a tool in the matcher
but missing from the runtime policy) and, per ENG-214 principle #6, sweeps
every site carrying the same enumeration.

**What it asserts:**

1. **session-start.sh naming** — every matcher-gated tool is *named* in the
   runtime-policy heredoc. The matching contract: a tool counts as named iff
   its FULL name (`mcp__server__tool`) appears as a plain substring, OR its
   SHORT name appears snake-token-bounded
   (`(?<![A-Za-z0-9_])S(?![A-Za-z0-9_])`). This is deliberate: a plain
   `\bS\b` word boundary would wrongly report a clean repo as missing (`_` is
   a regex word char, so `\bdeploy_app\b` matches nothing inside
   `...fred__deploy_app`), and a plain substring on the short name would
   *lying-green* match inside `deploy_app_orchestrated`. `deploy_app` is the
   lone full-form-only tool, named via the F-substring clause.
2. **CLAUDE.md gated-tools list parity** — the "Tools gated by the PreToolUse
   hook" bullet list in `CLAUDE.md` must set-equal the matcher (no missing,
   no extra). The list is parsed bullet-scoped, so the following
   "...`request_faucet` is intentionally not gated" paragraph is excluded; a
   missing heading throws (a rename must fail, not silently pass).
3. ci.yml ↔ matcher parity is already enforced by the pre-existing "Verify
   PreToolUse matcher" CI step, so it's not duplicated here.

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

**Running locally:** `npm run test:policy-completeness` (no deps needed).

## What CI runs

`.github/workflows/ci.yml`:

1. `node --check` syntax check on every `scripts/*.cjs` and `ci/*.cjs`.
2. `bash -n` syntax check on every `scripts/*.sh`.
3. `JSON.parse` on every tracked `.json` file.
4. Version consistency: `package.json` and `.claude-plugin/plugin.json` must match.
5. PreToolUse matcher: every alternative is `^...$`-anchored, the matcher gates exactly the expected broadcast tools (no missing, no extra), AND it does NOT accidentally match any of the `mcp__manifest-agent__*_orchestrated` wrapper tools. The negative-match list guards against double-prompt: the orchestrated wrappers dispatch the inner broadcast tools internally, which already trigger the hook on their own — a regex that matched both would prompt the user twice for one logical broadcast. Edit the expected list (and the negative-match list, if a new orchestrated tool ships) in `ci.yml` when the surface changes.
6. PreToolUse policy completeness (`npm run test:policy-completeness` → `ci/policy-completeness.cjs`): every matcher-gated tool is named in the `scripts/session-start.sh` runtime policy (the R3 fix), AND the `CLAUDE.md` "Tools gated by the PreToolUse hook" list set-equals the matcher (principle #6). See "Doc/code drift checks" above for the matching contract and allowlist rules.
7. SessionStart policy: `bash scripts/session-start.sh` must produce non-empty stdout that contains `cosmos_estimate_fee`.
8. MCP binary presence: `manifest-mcp-{chain,lease,fred,cosmwasm,agent}` are installed and executable.
9. `NODE_PATH` resolution: `@cosmjs/proto-signing` is reachable from the install dir.
10. Unit tests: `node --test tests/*.test.cjs`. Post-ENG-130 the suite covers wrapper plumbing (`tests/start-server.test.cjs` — env-var contract for all five servers including `agent`), the journal layer (`tests/_journal.test.cjs` + `tests/journal-{read,write}.test.cjs` — including the four new orchestrated-tool reducers), the read-only renderers, the env merge, the saved-manifest summarizer, and the two drift-check harnesses (`tests/docs-ci.test.cjs`, `tests/policy-completeness.test.cjs` — the demonstrated-drift proofs). Orchestration logic itself (plan rendering, classification, recovery dispatch) is tested upstream in `manifest-mcp-mono`.
11. Executable docs (`npm run test:docs` → `ci/docs-ci.cjs docs/testing.md`): runs the `docs-ci`-tagged shell examples and asserts their `expect`/`expect-not` directives hold. Runs after the runtime-deps install so `NODE_PATH` resolves. See "Doc/code drift checks" above.

If you change the broadcast-tool surface, you must update `hooks/hooks.json`, the matcher's expected list in `ci.yml`, and the "Tools gated by the PreToolUse hook" list in `CLAUDE.md` — all in the same commit, and the policy-completeness check (#6 above) now machine-enforces that all three stay in sync.

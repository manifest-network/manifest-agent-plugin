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
NODE_PATH="$INSTALL_DIR/node_modules" node --test tests/evaluate-readiness.test.cjs
```

## Test file layout

```
tests/
├── _subprocess.cjs         shared spawnSync helper for CLI-script tests
├── <script>.test.cjs       one test file per script under test
└── _<helper>.test.cjs      one test file per underscore-prefix helper
```

Conventions:

- File name mirrors the script under test: `evaluate-readiness.cjs` → `tests/evaluate-readiness.test.cjs`. Underscore helpers get an underscore prefix in the test file too: `_io.cjs` → `tests/_io.test.cjs`.
- One `node:test` `test(...)` per assertion or tightly scoped behavior. Group with `describe` only when there's real shared setup; otherwise top-level `test` calls keep the failure output readable.
- Tests should be hermetic: no real network, no real chain RPC, no real disk outside `os.tmpdir()`. Stub by passing fixture data on stdin or via `--*-file` flags pointing at tmpfiles.

## Two flavors of test

### In-process (`require()` the helper directly)

Used for underscore-prefix helpers that export functions. Example: `tests/_uuid.test.cjs` requires `scripts/_uuid.cjs` and calls the exported `isUuid` function. Fast, no subprocess overhead.

### Out-of-process (subprocess via `_subprocess.cjs`)

Used for CLI entry-point scripts where the contract is the stdin/stdout/exit-code envelope. The shared helper at `tests/_subprocess.cjs` exposes:

```js
const { runScript } = require('./_subprocess.cjs');
const result = runScript('evaluate-readiness.cjs', ['--gas-price', '0.001umfx'], stdinPayload);
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
- [ ] Each enumerated output classification, if the script is a classifier (e.g. `evaluate-readiness.cjs` has `ok` / `warn` / `block`)
- [ ] Boundary conditions for any threshold the script enforces (e.g. gas-price floor, FQDN length cap)

For schema-evolving wrappers (`save-manifest.cjs` / `summarize-manifest.cjs`), include both:

- A v(N) fixture asserting the new shape works.
- A v(N-1) fixture asserting the reader still loads it (missing fields render as undefined, not throw).

## Exercising scripts manually

Useful for debugging without standing up a full Claude session.

```bash
# One-time setup
export MANIFEST_PLUGIN_DATA="$HOME/.manifest-agent-dev"
mkdir -p "$MANIFEST_PLUGIN_DATA"
cp package.json "$MANIFEST_PLUGIN_DATA/"
npm install --omit=dev --prefix "$MANIFEST_PLUGIN_DATA"
export NODE_PATH="$MANIFEST_PLUGIN_DATA/node_modules"

# Fetch chain registry
node scripts/fetch-chain-registry.cjs

# Generate a key (reads password from stdin)
echo "test-password" | node scripts/gen-agent-key.cjs --prefix manifest

# Run a classifier with a stdin fixture
echo '{ "ok": true, "wallet_balances": [{ "denom": "umfx", "amount": "1000000" }] }' \
  | node scripts/evaluate-readiness.cjs --gas-price 0.001umfx --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/testnet.json"

# Render a deployment plan (stdout is the canonical block).
# Reads a {summary, readiness} envelope on stdin; --tx-fee is the human-readable
# string from humanize-fee.cjs (e.g. "0.0023 MFX"), NOT raw <amount><denom>.
echo '{
  "summary": { "format": "single", "service_count": 1, "image": "docker.io/library/nginx:1.27" },
  "readiness": { "wallet_balances": [{ "denom": "umfx", "amount": "1000000" }] }
}' | node scripts/render-deployment-plan.cjs \
  --meta-hash 0xabc... \
  --image docker.io/library/nginx:1.27 \
  --size <sku-id> \
  --tx-gas 150000 \
  --tx-fee "0.0023 MFX" \
  --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/testnet.json"

# Test the MCP wrapper end-to-end (requires config.json)
node scripts/start-server.cjs chain
```

## What CI runs

`.github/workflows/ci.yml`:

1. `node --check` syntax check on every `scripts/*.cjs`.
2. `bash -n` syntax check on every `scripts/*.sh`.
3. `JSON.parse` on every tracked `.json` file.
4. Version consistency: `package.json` and `.claude-plugin/plugin.json` must match.
5. PreToolUse matcher: every alternative is `^...$`-anchored AND the matcher gates exactly the expected broadcast tools (no missing, no extra). Edit the expected list in `ci.yml` when adding/removing a broadcast tool.
6. SessionStart policy: `bash scripts/session-start.sh` must produce non-empty stdout that contains `cosmos_estimate_fee`.
7. MCP binary presence: `manifest-mcp-{chain,lease,fred,cosmwasm}` are installed and executable.
8. `NODE_PATH` resolution: `@cosmjs/proto-signing` is reachable from the install dir.
9. Unit tests: `node --test tests/*.test.cjs`.

If you change the broadcast-tool surface, you must update `hooks/hooks.json`, the matcher's expected list in `ci.yml`, and the "Tools gated by the PreToolUse hook" list in `CLAUDE.md` — all in the same commit.

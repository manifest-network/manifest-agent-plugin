'use strict';

/**
 * Demonstrated-drift unit test for the executable-docs harness
 * (`ci/docs-ci.cjs`, ENG-213 Check 1).
 *
 * This is the principle-#2 (ENG-214) red-green proof that the check
 * actually FIRES on the bug class it claims to catch — not a guard that
 * can't fail. Every assertion drives an exported pure function with
 * SYNTHETIC fixture markdown + hermetic `echo`/`exit` commands (no plugin
 * deps, no network), so the test is fast and self-contained.
 *
 * The canonical drift it proves catchable is the PR #9 R4b regression:
 * `render-balance.cjs` reads `payload.balances` / `payload.credits`, but
 * the docs example used `wallet_balances` / `credit`. Wrong keys →
 * "(unavailable)" in the rendered output while the process still exits 0,
 * so an exit-code-only check would pass. The `expect-not="(unavailable)"`
 * directive is what catches it; the "RED (expect-not hit)" case below
 * simulates exactly that sentinel.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

const { extractBlocks, parseDirectives, runBlock, seedDataDir, evaluateResult } = require('../ci/docs-ci.cjs');

const REPO_ROOT = join(__dirname, '..');
// A label, not a real read — runBlock only uses it to build the
// `<file>:<line>` location prefix in failure messages.
const SOURCE = 'docs/testing.md';

function md(...lines) {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// extractBlocks — directive grammar
// ---------------------------------------------------------------------------

test('extractBlocks parses a bare marker directive + fence', () => {
  const blocks = extractBlocks(md(
    'Some prose.',
    '',
    '<!-- docs-ci -->',
    '```bash',
    'echo hello',
    '```',
    '',
    'More prose.',
  ));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, 'bash');
  assert.equal(blocks[0].code, 'echo hello');
  assert.deepEqual(blocks[0].directives, {
    network: false,
    allowNonzero: false,
    expect: [],
    expectNot: [],
  });
  // line points at the opening fence (1-based) for failure messages.
  assert.equal(blocks[0].line, 4);
});

test('extractBlocks parses all directive tokens: network, repeated expect/expect-not, allow-nonzero', () => {
  const blocks = extractBlocks(md(
    '<!-- docs-ci network expect="a" expect-not="b" expect="c" allow-nonzero -->',
    '```bash',
    'echo hi',
    '```',
  ));
  assert.equal(blocks.length, 1);
  const d = blocks[0].directives;
  assert.equal(d.network, true, 'network flag must be parsed');
  assert.equal(d.allowNonzero, true, 'allow-nonzero flag must be parsed');
  assert.deepEqual(d.expect, ['a', 'c'], 'expect is repeatable and order-preserving');
  assert.deepEqual(d.expectNot, ['b'], 'expect-not is repeatable');
});

test('parseDirectives does not confuse expect-not with expect', () => {
  const d = parseDirectives(' expect-not="(unavailable)" ');
  assert.deepEqual(d.expect, [], 'expect-not="..." must NOT register as an expect');
  assert.deepEqual(d.expectNot, ['(unavailable)']);
});

test('extractBlocks ignores an INDENTED directive (illustrative example in prose is not extracted)', () => {
  // The contributor docs show a `<!-- docs-ci ... -->` example inside a
  // 4-space-indented block. That example must NOT be picked up and run.
  const blocks = extractBlocks(md(
    'How to tag a block:',
    '',
    '    <!-- docs-ci expect="MFX" -->',
    '    ```bash',
    '    echo illustrative',
    '    ```',
  ));
  assert.equal(blocks.length, 0);
});

test('extractBlocks ignores an INLINE directive mention in a prose sentence', () => {
  // A line that merely contains the directive in backticks mid-sentence
  // must not match (and must not throw "not followed by a fence").
  const blocks = extractBlocks(md(
    'Tag the block with `<!-- docs-ci expect="MFX" -->` on the line before the fence.',
    '',
    'Some other prose.',
  ));
  assert.equal(blocks.length, 0);
});

test('extractBlocks ignores fences with no preceding docs-ci directive', () => {
  const blocks = extractBlocks(md(
    '```bash',
    'echo untagged',
    '```',
  ));
  assert.equal(blocks.length, 0);
});

test('extractBlocks throws when a directive is not followed by a fence', () => {
  assert.throws(
    () => extractBlocks(md('<!-- docs-ci -->', 'just prose, no fence')),
    /not followed by a fenced code block/,
  );
});

test('extractBlocks throws on an unknown directive token (anti-typo / anti-lying-guard)', () => {
  assert.throws(
    () => extractBlocks(md('<!-- docs-ci expct="MFX" -->', '```bash', 'echo hi', '```')),
    /Unknown docs-ci directive token/,
  );
});

// ---------------------------------------------------------------------------
// runBlock — GREEN cases
// ---------------------------------------------------------------------------

test('GREEN: expect substring present', () => {
  const [block] = extractBlocks(md('<!-- docs-ci expect="hello" -->', '```bash', 'echo hello', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
  assert.equal(r.status, 0);
});

test('GREEN: default mode (no directives) — exit 0 + non-empty stdout', () => {
  const [block] = extractBlocks(md('<!-- docs-ci -->', '```bash', 'echo something', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
});

test('GREEN: allow-nonzero lets a nonzero exit pass', () => {
  const [block] = extractBlocks(md('<!-- docs-ci allow-nonzero -->', '```bash', 'echo boom; exit 3', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
  assert.equal(r.status, 3);
});

// ---------------------------------------------------------------------------
// runBlock — RED cases (the principle-#2 proofs)
// ---------------------------------------------------------------------------

test('RED (expect miss): missing substring fails; message names the file:line + the substring', () => {
  const [block] = extractBlocks(md('<!-- docs-ci expect="goodbye" -->', '```bash', 'echo hello', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false);
  const msg = r.failures.join('\n');
  // Directive on line 1, fence opener on line 2 -> location names the fence.
  assert.match(msg, /docs\/testing\.md:2/, 'failure message must carry the file:line ref');
  assert.match(msg, /goodbye/, 'failure message must name the expected substring');
});

test('RED (expect-not hit): the R4b "(unavailable)" sentinel drift class', () => {
  // Simulates render-balance.cjs drift: wrong payload keys make the
  // renderer emit "(unavailable)" while still exiting 0. exit-code-only
  // would miss it; expect-not catches it.
  const [block] = extractBlocks(md(
    '<!-- docs-ci expect-not="(unavailable)" -->',
    '```bash',
    'echo "- Burn rate: (unavailable) / hour"',
    '```',
  ));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false, 'a block whose output contains the forbidden sentinel must FAIL');
  assert.equal(r.status, 0, 'and it must fail despite a clean exit 0 — the whole point');
  const msg = r.failures.join('\n');
  assert.match(msg, /docs\/testing\.md:2/);
  assert.match(msg, /\(unavailable\)/, 'failure message must name the forbidden substring');
});

test('RED (nonzero exit, default mode): nonzero without allow-nonzero fails', () => {
  const [block] = extractBlocks(md('<!-- docs-ci -->', '```bash', 'echo oops; exit 1', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false);
  assert.equal(r.status, 1);
  assert.match(r.failures.join('\n'), /docs\/testing\.md:2/);
});

test('RED (default mode): exit 0 but empty stdout fails', () => {
  const [block] = extractBlocks(md('<!-- docs-ci -->', '```bash', 'true', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false, 'default mode requires non-empty stdout');
  assert.equal(r.status, 0);
});

// ---------------------------------------------------------------------------
// evaluateResult — pure failure-classification (Copilot R2, finding 1)
// ---------------------------------------------------------------------------

const CLEAN_DIRECTIVES = { network: false, allowNonzero: false, expect: [], expectNot: [] };

test('evaluateResult: a spawn error yields ONLY the spawn-error failure, never "exited <status>"', () => {
  // res.error is set and status is null (spawnSync couldn't launch the
  // process). The old two-independent-`if` form also fired the
  // `null !== 0` exit-status branch, emitting a misleading
  // "command exited null". The `else if` chaining suppresses that.
  const failures = evaluateResult(
    { error: new Error('spawn bash ENOENT'), status: null, stdout: '', stderr: '' },
    CLEAN_DIRECTIVES,
    'docs/testing.md:42',
  );
  const msg = failures.join('\n');
  assert.match(msg, /failed to spawn command/);
  assert.doesNotMatch(msg, /exited/, 'a spawn failure must NOT also assert "command exited null"');
});

test('evaluateResult: a 127 (missing inner command via bash -c) is a normal nonzero exit, not a spawn error', () => {
  // The real-world path Copilot mislabeled as ENOENT: bash launches fine,
  // the inner command is missing, exit 127, res.error is null.
  const failures = evaluateResult(
    { error: null, status: 127, stdout: '', stderr: 'bash: cmd: command not found' },
    CLEAN_DIRECTIVES,
    'docs/testing.md:42',
  );
  const msg = failures.join('\n');
  assert.match(msg, /command exited 127/);
  assert.doesNotMatch(msg, /failed to spawn command/);
});

test('evaluateResult: clean exit + non-empty stdout (default mode) -> no failures', () => {
  const failures = evaluateResult(
    { error: null, status: 0, stdout: 'output\n', stderr: '' },
    CLEAN_DIRECTIVES,
    'docs/testing.md:42',
  );
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// runBlock — NODE_PATH diagnostic hint (Finding C)
// ---------------------------------------------------------------------------

test('runBlock appends a NODE_PATH hint when a failed block stderr shows "Cannot find module"', () => {
  // A contributor who forgets to set NODE_PATH gets a raw module-resolution
  // error from an executed example (e.g. gen-agent-key needs
  // @cosmjs/proto-signing). Surface a pointer at the setup docs instead of
  // leaving them with a bare stack trace. Hermetic: just require a module
  // that does not exist anywhere.
  const [block] = extractBlocks(md(
    '<!-- docs-ci -->',
    '```bash',
    "node -e \"require('totally-missing-module-xyz')\"",
    '```',
  ));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false);
  const msg = r.failures.join('\n');
  assert.match(msg, /Cannot find module/, 'the raw module error is still surfaced');
  assert.match(msg, /NODE_PATH/, 'a NODE_PATH hint is appended');
  assert.match(msg, /One-time setup|docs\/testing\.md/, 'the hint points at the setup docs');
});

test('runBlock does NOT append the NODE_PATH hint for an ordinary failure (no module error)', () => {
  // The hint must be specific to module-resolution failures, not noise on
  // every failed block.
  const [block] = extractBlocks(md('<!-- docs-ci expect="goodbye" -->', '```bash', 'echo hello', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.failures.join('\n'), /NODE_PATH/, 'no module error -> no NODE_PATH hint');
});

// ---------------------------------------------------------------------------
// runBlock — NODE_PATH env-shape propagation (Copilot R1, finding 1)
// ---------------------------------------------------------------------------

// A block that reports whether the CHILD process sees NODE_PATH as a real
// value, an empty string, or absent — the only clean way to observe the env
// runBlock builds for the spawned command.
const NP_PROBE = "node -e \"console.log('NP=' + (process.env.NODE_PATH===undefined ? 'ABSENT' : JSON.stringify(process.env.NODE_PATH)))\"";

test('runBlock passes the parent NODE_PATH through to the child when set', () => {
  const saved = process.env.NODE_PATH;
  process.env.NODE_PATH = '/known/test/path';
  try {
    const [block] = extractBlocks(md('<!-- docs-ci -->', '```bash', NP_PROBE, '```'));
    const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
    assert.match(r.stdout, /NP="\/known\/test\/path"/);
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved;
  }
});

test('runBlock does NOT inject an empty NODE_PATH into the child when the parent has none', () => {
  // RED-GREEN anchor for the fix: the old `NODE_PATH: process.env.NODE_PATH || ''`
  // forced NODE_PATH="" on the child (a spurious empty var that contradicts the
  // ...process.env inheritance). The child must instead see NODE_PATH ABSENT,
  // exactly as if runBlock weren't touching it.
  const saved = process.env.NODE_PATH;
  delete process.env.NODE_PATH;
  try {
    const [block] = extractBlocks(md('<!-- docs-ci -->', '```bash', NP_PROBE, '```'));
    const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
    assert.match(r.stdout, /NP=ABSENT/);
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved;
  }
});

// ---------------------------------------------------------------------------
// runBlock — network skip behavior
// ---------------------------------------------------------------------------

test('network block is skipped when runNetwork is false', () => {
  const [block] = extractBlocks(md('<!-- docs-ci network -->', '```bash', 'echo net', '```'));
  // Pass runNetwork explicitly so the test is hermetic — it must not depend
  // on whether DOCS_CI_RUN_NETWORK happens to be set in the runner's env.
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE, runNetwork: false });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true, 'a skipped block is not a failure');
});

test('network block runs when ctx.runNetwork is true', () => {
  const [block] = extractBlocks(md('<!-- docs-ci network expect="net" -->', '```bash', 'echo net', '```'));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE, runNetwork: true });
  assert.notEqual(r.skipped, true);
  assert.equal(r.ok, true, `failures: ${r.failures.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// runBlock — setup block must not clobber the injected MANIFEST_PLUGIN_DATA
// (Copilot R2, finding 2)
// ---------------------------------------------------------------------------

// The harness seeds chains/testnet.json into the injected tempdir, so its
// presence is a positive marker that the block's `$MANIFEST_PLUGIN_DATA`
// resolved to the harness tempdir rather than a hardcoded default. Hermetic:
// no network, no $HOME writes, no real npm install.
const MPD_PROBE = 'test -f "$MANIFEST_PLUGIN_DATA/chains/testnet.json" && echo INJECTED || echo CLOBBERED';

test('setup block with `${MANIFEST_PLUGIN_DATA:-default}` preserves the harness-injected dir', () => {
  // The fix: parameter-default expansion yields to the injected value.
  const [block] = extractBlocks(md(
    '<!-- docs-ci -->',
    '```bash',
    'export MANIFEST_PLUGIN_DATA="${MANIFEST_PLUGIN_DATA:-/docs-ci-should-not-resolve-here}"',
    MPD_PROBE,
    '```',
  ));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.match(r.stdout, /INJECTED/, 'parameter-default must keep MANIFEST_PLUGIN_DATA pointed at the injected tempdir');
});

test('setup block with an UNCONDITIONAL export clobbers the injected dir (the bug the fix prevents)', () => {
  // Before-form: unconditional assignment escapes the harness tempdir —
  // exactly why the real "One-time setup" block's mkdir + npm install would
  // have landed in the user's real $HOME under DOCS_CI_RUN_NETWORK=1.
  const [block] = extractBlocks(md(
    '<!-- docs-ci -->',
    '```bash',
    'export MANIFEST_PLUGIN_DATA="/docs-ci-should-not-resolve-here"',
    MPD_PROBE,
    '```',
  ));
  const r = runBlock(block, { repoRoot: REPO_ROOT, sourceFile: SOURCE });
  assert.match(r.stdout, /CLOBBERED/, 'unconditional export must demonstrably escape the injected tempdir');
});

// ---------------------------------------------------------------------------
// seedDataDir — offline render-balance fixture
// ---------------------------------------------------------------------------

test('seedDataDir writes a minimal chains/testnet.json with the MFX/PWR fee tokens', () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'docs-ci-seed-'));
  try {
    seedDataDir(dir);
    const p = join(dir, 'chains', 'testnet.json');
    assert.ok(existsSync(p), 'chains/testnet.json must exist after seeding');
    const data = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(Array.isArray(data.feeTokens));
    const symbols = data.feeTokens.map((t) => t.symbol);
    assert.ok(symbols.includes('MFX'), 'seed must map umfx -> MFX so render-balance shows MFX offline');
    assert.ok(symbols.includes('PWR'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

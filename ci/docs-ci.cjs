#!/usr/bin/env node
'use strict';

/**
 * Executable-docs check (ENG-213 Check 1).
 *
 * Extracts the shell examples in a Markdown file that are explicitly
 * marked for execution, runs each in an isolated tempdir, and asserts
 * the documented expectations hold. This closes the doc/code drift class
 * Copilot caught on PR #9 (R4b): a worked example in docs/testing.md used
 * the wrong `render-balance.cjs` payload keys, so the rendered output
 * showed "(unavailable)" while the process still exited 0 — invisible to
 * an exit-code-only check. The `expect-not="(unavailable)"` directive is
 * what catches that.
 *
 * Usage:
 *   node ci/docs-ci.cjs docs/testing.md
 *
 * File-parameterized so it can target any doc later (docs/scripts.md has
 * no copy-pasteable examples today, so it is out of scope for now).
 *
 * ## Directive grammar (HTML-comment, immediately preceding the fence)
 *
 * A block is opted in by an HTML comment that occupies its OWN LINE at
 * column 0 (no leading indentation, nothing after `-->`), whose next
 * non-blank line MUST open a fenced code block. The column-0 / whole-line
 * requirement is deliberate: it lets prose ELSEWHERE in the doc mention or
 * illustrate a `<!-- docs-ci ... -->` directive (inline in a sentence, or
 * inside an indented example block) without that mention being extracted
 * and executed. The comment is invisible in rendered Markdown (clean
 * published doc) but carries structured assertion metadata a fence
 * info-string can't, and is grep-able (`grep -n docs-ci docs/testing.md`):
 *
 *   <!-- docs-ci -->                  marker; run the next fence.
 *   network                           skip unless env DOCS_CI_RUN_NETWORK=1
 *                                     (inventoried-but-skipped: documents
 *                                     intent rather than silently omitting).
 *   expect="<substr>"                 repeatable; stdout MUST contain it.
 *   expect-not="<substr>"             repeatable; stdout MUST NOT contain it.
 *   allow-nonzero                     don't fail on a nonzero exit (for
 *                                     examples that demonstrate errors).
 *
 * Default (no expect / expect-not): assert exit 0 AND non-empty stdout.
 *
 * ## Isolation
 *
 * Each block runs in its own fresh tempdir with:
 *   MANIFEST_PLUGIN_DATA=<tmp>   (seeded with a minimal chains/testnet.json
 *                                 so the render-balance example resolves
 *                                 denom symbols offline)
 *   NODE_PATH=<inherited>        (so CI's $HOME/.manifest-agent/node_modules
 *                                 resolves @cosmjs/* etc.; locally you set
 *                                 it per docs/testing.md's setup section)
 *   cwd = repo root              (so `node scripts/...` resolves)
 * The tempdir is removed after each block. Per-block, not shared — matches
 * the hermetic-test convention (no real disk outside os.tmpdir()).
 *
 * Exit: 0 if every non-skipped block passed; 1 otherwise (or on a parse
 * error in the directive grammar).
 */

const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

// Minimal chain-registry fixture for offline denom -> symbol humanization.
// Shape matches the `feeTokens[]` array render-balance.cjs / humanize-denom.cjs
// read (confirmed against tests/render-balance.test.cjs). Kept inline to
// honor docs/testing.md's "no tests/fixtures/ dir" convention.
const SEED_CHAIN = {
  feeTokens: [
    { denom: 'umfx', symbol: 'MFX' },
    { denom: 'factory/manifest1xxx/upwr', symbol: 'PWR' },
  ],
};

const KNOWN_FLAGS = new Set(['network', 'allow-nonzero']);

/**
 * Parse a directive comment body (everything after `docs-ci`) into a
 * structured `{ network, allowNonzero, expect[], expectNot[] }`.
 * Throws on an unrecognized token so a typo (`expct=`) FAILS loudly rather
 * than silently degrading the block to default mode (anti-lying-guard).
 */
function parseDirectives(body) {
  const expect = [...body.matchAll(/expect="([^"]*)"/g)].map((m) => m[1]);
  const expectNot = [...body.matchAll(/expect-not="([^"]*)"/g)].map((m) => m[1]);
  // Strip the key="value" tokens so only bare flags remain to validate.
  // expect-not first (longer key) so the expect strip can't clip it.
  const stripped = body
    .replace(/expect-not="[^"]*"/g, ' ')
    .replace(/expect="[^"]*"/g, ' ');
  let network = false;
  let allowNonzero = false;
  for (const tok of stripped.split(/\s+/).filter(Boolean)) {
    if (tok === 'network') network = true;
    else if (tok === 'allow-nonzero') allowNonzero = true;
    else if (!KNOWN_FLAGS.has(tok)) {
      throw new Error(`Unknown docs-ci directive token: "${tok}"`);
    }
  }
  return { network, allowNonzero, expect, expectNot };
}

/**
 * Extract every docs-ci-tagged code block from Markdown text.
 * Returns [{ lang, code, directives, line }] where `line` is the 1-based
 * line number of the opening fence (used in failure messages).
 */
function extractBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    // Anchored: the directive must be the WHOLE line at column 0. This keeps
    // inline mentions in prose, and indented illustrative examples, from
    // being picked up as runnable blocks (the contributor docs show a
    // `<!-- docs-ci ... -->` example, and that example must not execute).
    const dm = lines[i].match(/^<!--\s*docs-ci\b(.*?)-->\s*$/);
    if (!dm) continue;
    const directives = parseDirectives(dm[1]);
    // The directive's next non-blank line MUST open a fence.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length || !/^\s*```/.test(lines[j])) {
      throw new Error(
        `docs-ci directive on line ${i + 1} is not followed by a fenced code block`,
      );
    }
    const langMatch = lines[j].match(/^\s*```(\S*)/);
    const lang = langMatch ? langMatch[1] : '';
    const codeLines = [];
    let k = j + 1;
    while (k < lines.length && !/^\s*```\s*$/.test(lines[k])) {
      codeLines.push(lines[k]);
      k++;
    }
    if (k >= lines.length) {
      throw new Error(
        `docs-ci directive on line ${i + 1} opens an unterminated code fence`,
      );
    }
    blocks.push({ lang, code: codeLines.join('\n'), directives, line: j + 1 });
    i = k; // resume scanning after the closing fence
  }
  return blocks;
}

/** Seed an isolated MANIFEST_PLUGIN_DATA dir with the offline chain fixture. */
function seedDataDir(dir) {
  const chainsDir = join(dir, 'chains');
  mkdirSync(chainsDir, { recursive: true });
  writeFileSync(join(chainsDir, 'testnet.json'), JSON.stringify(SEED_CHAIN, null, 2), 'utf8');
}

function snippet(text, maxLines = 12) {
  const out = (text || '').split('\n').slice(0, maxLines).join('\n');
  return out.length ? out : '(no output)';
}

/**
 * Run one extracted block in an isolated tempdir and evaluate its
 * directives. Returns { ok, status, stdout, stderr, failures[], skipped? }.
 *
 * ctx: { repoRoot, sourceFile, runNetwork? }
 *   - repoRoot   cwd for the command (so `node scripts/...` resolves)
 *   - sourceFile label used in the `<file>:<line>` failure prefix
 *   - runNetwork override for the network gate (defaults from env)
 */
function runBlock(block, ctx) {
  const { repoRoot, sourceFile = 'doc' } = ctx;
  const d = block.directives;
  const loc = `${sourceFile}:${block.line}`;
  const runNetwork = ctx.runNetwork !== undefined
    ? ctx.runNetwork
    : process.env.DOCS_CI_RUN_NETWORK === '1';

  if (d.network && !runNetwork) {
    return { ok: true, skipped: true, status: null, stdout: '', stderr: '', failures: [] };
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'docs-ci-'));
  seedDataDir(dataDir);
  try {
    const res = spawnSync('bash', ['-c', block.code], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MANIFEST_PLUGIN_DATA: dataDir,
        // Inherit NODE_PATH untouched: `...process.env` already carries it
        // when set, and when unset we must NOT inject `NODE_PATH=''` — a
        // spurious empty var that differs from the natural unset state. (It
        // doesn't mask the module-not-found hint — empty and absent are
        // equivalent for Node resolution — but passing a bogus empty env var
        // to every example block is wrong on its face.)
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      },
    });
    const failures = evaluateResult(res, d, loc);
    return {
      ok: failures.length === 0,
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      failures,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Pure failure-classification for a spawnSync result against a block's
 * directives. Extracted from runBlock so the branches — spawn-error vs
 * exit-status especially — are unit-testable with synthetic result objects
 * (a real `bash -c` with a missing inner command exits 127 and never
 * populates `res.error`, so the spawn-error branch is otherwise unreachable
 * from an integration test).
 *
 * `res` is `{ error, status, stdout, stderr }` (the spawnSync shape).
 * Returns a `failures[]` array; empty means the block passed.
 */
function evaluateResult(res, directives, loc) {
  const d = directives;
  const status = res.status;
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const failures = [];
  const hasExpectations = d.expect.length > 0 || d.expectNot.length > 0;

  // A spawn failure (res.error, status null) precludes the exit-status
  // assertion: `else if` keeps `null !== 0` from also emitting a misleading
  // "command exited null".
  if (res.error) {
    failures.push(`${loc}: failed to spawn command — ${res.error.message}`);
  } else if (status !== 0 && !d.allowNonzero) {
    failures.push(
      `${loc}: command exited ${status} (expected 0; add \`allow-nonzero\` if intended)\n`
      + `  stderr: ${snippet(stderr)}`,
    );
  }

  for (const sub of d.expect) {
    if (!stdout.includes(sub)) {
      failures.push(
        `${loc}: expected stdout to contain "${sub}" — got:\n  ${snippet(stdout).replace(/\n/g, '\n  ')}`,
      );
    }
  }
  for (const sub of d.expectNot) {
    if (stdout.includes(sub)) {
      failures.push(
        `${loc}: expected stdout to NOT contain "${sub}" — got:\n  ${snippet(stdout).replace(/\n/g, '\n  ')}`,
      );
    }
  }

  // Default mode (no expect/expect-not): a clean exit must still produce
  // output, otherwise the example silently did nothing.
  if (!hasExpectations && !d.allowNonzero && status === 0 && stdout.trim().length === 0) {
    failures.push(`${loc}: expected non-empty stdout (default mode) — command produced none`);
  }

  // Diagnostic hint: a Node MODULE_NOT_FOUND in a failed block almost always
  // means deps aren't on the resolution path — the usual cause is a
  // contributor running `npm run test:docs` without NODE_PATH set (the
  // render-balance example needs ./humanize-denom.cjs; gen-agent-key needs
  // @cosmjs/proto-signing). Point them at the setup rather than leaving a
  // bare stack trace. Failure-message-only: never flips a pass to a fail.
  if (failures.length > 0 && /Cannot find module/.test(stderr)) {
    failures.push(
      `${loc}: hint — "Cannot find module" usually means deps aren't resolvable; `
      + 'set NODE_PATH to your install dir per docs/testing.md → "One-time setup" '
      + '(CI sets it automatically).',
    );
  }

  return failures;
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('usage: node ci/docs-ci.cjs <markdown-file>');
    process.exit(1);
  }

  let md;
  try {
    md = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`docs-ci: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }

  let blocks;
  try {
    blocks = extractBlocks(md);
  } catch (err) {
    console.error(`docs-ci: ${err.message}`);
    process.exit(1);
  }

  const ctx = { repoRoot: process.cwd(), sourceFile: file };
  let ran = 0;
  let skipped = 0;
  let failed = 0;

  for (const block of blocks) {
    const r = runBlock(block, ctx);
    if (r.skipped) {
      skipped++;
      console.log(`SKIP ${file}:${block.line} (network; set DOCS_CI_RUN_NETWORK=1 to run)`);
      continue;
    }
    ran++;
    if (r.ok) {
      console.log(`PASS ${file}:${block.line}`);
    } else {
      failed++;
      console.error(`FAIL ${file}:${block.line}`);
      for (const f of r.failures) console.error(`  ${f}`);
    }
  }

  console.log(`docs-ci: ${ran} ran, ${skipped} skipped, ${failed} failed (${blocks.length} tagged)`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { extractBlocks, parseDirectives, runBlock, evaluateResult, seedDataDir, SEED_CHAIN };

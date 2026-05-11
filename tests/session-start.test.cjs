'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'session-start.sh');

// Tools the session-start.sh hook needs available in PATH. Used to build a
// jq-less PATH for testing the grep+sed fallback: we create a shim directory
// containing symlinks to everything EXCEPT jq, then set PATH to just that
// dir. Bash's `command -v jq` then returns false because no executable
// named `jq` is reachable.
const HOOK_TOOLS = [
  'bash', 'sh', 'cat', 'grep', 'head', 'sed', 'cp', 'diff', 'rm', 'mkdir',
  'chmod', 'true', 'false', 'env', 'printf', 'tr', 'cut',
];

function buildShimWithoutJq() {
  const shim = mkdtempSync(join(tmpdir(), 'session-start-shim-no-jq-'));
  for (const t of HOOK_TOOLS) {
    for (const dir of ['/bin', '/usr/bin', '/usr/local/bin']) {
      const src = join(dir, t);
      if (existsSync(src)) {
        try { symlinkSync(src, join(shim, t)); } catch { /* already linked */ }
        break;
      }
    }
  }
  return shim;
}

// Run session-start.sh with a controlled environment. Sets CLAUDE_PLUGIN_ROOT
// and CLAUDE_PLUGIN_DATA to a fresh tmpdir without a package.json so the
// npm-install branch is skipped (the diff-check needs both files to exist).
// CLAUDE_ENV_FILE points at a fresh file we read after the run.
function runHook({ stdin = '', pathOverride } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-start-root-'));
  const data = mkdtempSync(join(tmpdir(), 'session-start-data-'));
  const envFile = join(mkdtempSync(join(tmpdir(), 'session-start-env-')), 'env');
  const env = {
    PATH: pathOverride !== undefined ? pathOverride : process.env.PATH,
    HOME: process.env.HOME || '/tmp',
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_ENV_FILE: envFile,
  };
  // Locate bash via absolute path so the test works even when PATH excludes
  // common locations. Same logic for the script's other tools is handled
  // inside the shim builder.
  const bashPath = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) || 'bash';
  const res = spawnSync(bashPath, [SCRIPT], { input: stdin, encoding: 'utf8', env });
  let envContent = '';
  if (existsSync(envFile)) envContent = readFileSync(envFile, 'utf8');
  try {
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, envContent };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(join(envFile, '..'), { recursive: true, force: true });
  }
}

function withShimWithoutJq(fn) {
  const shim = buildShimWithoutJq();
  try {
    return fn(shim);
  } finally {
    rmSync(shim, { recursive: true, force: true });
  }
}

test('policy heredoc is always emitted on stdout', () => {
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The policy heredoc mentions cosmos_estimate_fee — same check CI runs.
  assert.match(r.stdout, /cosmos_estimate_fee/);
  assert.match(r.stdout, /manifest-agent runtime transaction policy/);
});

test('exports MANIFEST_PLUGIN_ROOT, MANIFEST_PLUGIN_DATA, NODE_PATH to CLAUDE_ENV_FILE', () => {
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0);
  assert.match(r.envContent, /export MANIFEST_PLUGIN_ROOT=/);
  assert.match(r.envContent, /export MANIFEST_PLUGIN_DATA=/);
  assert.match(r.envContent, /export NODE_PATH=/);
});

test('extracts session_id via jq when available and exports MANIFEST_SESSION_ID', () => {
  const r = runHook({ stdin: '{"session_id":"abc-jq-path","cwd":"/x"}' });
  assert.equal(r.status, 0);
  assert.match(r.envContent, /export MANIFEST_SESSION_ID=abc-jq-path/);
});

test('falls back to grep+sed when jq is unavailable', () => {
  withShimWithoutJq((shim) => {
    const r = runHook({
      stdin: '{"session_id":"sess-fallback","cwd":"/x"}',
      pathOverride: shim,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.envContent, /export MANIFEST_SESSION_ID=sess-fallback/);
  });
});

test('does NOT abort under `set -euo pipefail` when payload lacks session_id and jq is absent', () => {
  // Regression for commit 5691d36 (the `|| true` guard on the grep
  // pipeline). Without the guard, grep exits 1 (no match), pipefail
  // propagates the failure, and set -e aborts the whole hook —
  // preventing policy injection AND env var export. With the guard,
  // SESSION_ID stays empty, MANIFEST_SESSION_ID is not exported, but
  // the rest of the hook completes normally.
  withShimWithoutJq((shim) => {
    const r = runHook({
      stdin: '{"transcript_path":"/x","cwd":"/y"}', // no session_id field
      pathOverride: shim,
    });
    assert.equal(r.status, 0, `hook must not abort; stderr: ${r.stderr}`);
    assert.match(r.stdout, /cosmos_estimate_fee/, 'policy must still be emitted');
    assert.match(r.envContent, /export MANIFEST_PLUGIN_ROOT=/);
    // No session id was extractable, so MANIFEST_SESSION_ID is absent.
    assert.doesNotMatch(r.envContent, /MANIFEST_SESSION_ID/);
  });
});

test('does NOT export MANIFEST_SESSION_ID when stdin is empty', () => {
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.envContent, /MANIFEST_SESSION_ID/);
});

test('does NOT export MANIFEST_SESSION_ID when the jq path encounters non-JSON stdin', () => {
  // jq exits non-zero on malformed input; the `|| true` on that path
  // keeps the hook running. SESSION_ID stays empty, no export.
  const r = runHook({ stdin: 'not json at all' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.envContent, /MANIFEST_SESSION_ID/);
  assert.match(r.stdout, /cosmos_estimate_fee/);
});

test('does NOT export MANIFEST_SESSION_ID when the grep+sed fallback encounters non-JSON stdin', () => {
  // Mirror of the jq case, exercising the grep+sed code path.
  withShimWithoutJq((shim) => {
    const r = runHook({ stdin: 'not json at all', pathOverride: shim });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.envContent, /MANIFEST_SESSION_ID/);
    assert.match(r.stdout, /cosmos_estimate_fee/);
  });
});

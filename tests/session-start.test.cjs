'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync, cpSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = join(__dirname, '..', 'scripts', 'session-start.sh');
const hooks = require('../hooks/hooks.json');

function copyHostAdapter(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const name of ['host-env.cjs', '_host.cjs']) cpSync(join(__dirname, '../scripts', name), join(root, 'scripts', name));
}

// Tools the session-start.sh hook needs available in PATH. Used to build a
// jq-less PATH for testing the grep+sed fallback: we create a shim directory
// containing symlinks to everything EXCEPT jq, then set PATH to just that
// dir. Bash's `command -v jq` then returns false because no executable
// named `jq` is reachable.
const HOOK_TOOLS = [
  'bash', 'sh', 'cat', 'grep', 'head', 'sed', 'cp', 'diff', 'rm', 'mkdir',
  'chmod', 'node', 'true', 'false', 'env', 'printf', 'tr', 'cut',
];

function buildShimWithoutJq() {
  const shim = mkdtempSync(join(tmpdir(), 'session-start-shim-no-jq-'));
  for (const t of HOOK_TOOLS) {
    if (t === 'node') { symlinkSync(process.execPath, join(shim, t)); continue; }
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
// runtime setup branch is skipped. Bootstrap integration is tested below.
// CLAUDE_ENV_FILE points at a fresh file we read after the run.
function runHook({ stdin = '', pathOverride } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-start-root-'));
  const data = mkdtempSync(join(tmpdir(), 'session-start-data-'));
  copyHostAdapter(root);
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

test('policy describes the orchestrated tools as the preferred surface', () => {
  // After the ENG-130 rewire the orchestrated wrappers own plan,
  // confirmation, progress, and recovery. The runtime policy must
  // (a) name them, (b) describe the elicitation contract, and
  // (c) tell the agent NOT to compose its own plan/recap.
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /deploy_app_orchestrated/);
  assert.match(r.stdout, /manage_domain_orchestrated/);
  assert.match(r.stdout, /troubleshoot_deployment_orchestrated/);
  assert.match(r.stdout, /close_lease_orchestrated/);
  assert.match(r.stdout, /elicitInput|elicitation/i);
});

test('policy no longer references the deleted render-deployment-plan / format-success scripts', () => {
  // The orchestrated tools own plan rendering inside agent-core's
  // internals/render-* modules. The plugin-side renderers are gone
  // post-rewire; the policy must not point at them.
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /render-deployment-plan\.cjs/);
  assert.doesNotMatch(r.stdout, /format-success\.cjs/);
});

test('exports MANIFEST_PLUGIN_ROOT, MANIFEST_PLUGIN_DATA, NODE_PATH to CLAUDE_ENV_FILE', () => {
  const r = runHook({ stdin: '' });
  assert.equal(r.status, 0);
  assert.match(r.envContent, /export MANIFEST_PLUGIN_ROOT=/);
  assert.match(r.envContent, /export MANIFEST_PLUGIN_DATA=/);
  assert.match(r.envContent, /export NODE_PATH=/);
});

test('registered SessionStart command emits policy and usable exports from a spaced plugin path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest session hook '));
  try {
    const root = join(dir, 'plugin root');
    const data = join(dir, 'plugin data');
    const envFile = join(dir, 'session env');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(data);
    cpSync(SCRIPT, join(root, 'scripts/session-start.sh'));
    copyHostAdapter(root);
    const env = { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_ENV_FILE: envFile };
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync('/bin/bash', ['-c', command], {
      env, input: '{"session_id":"spaced-path-session"}', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manifest-agent runtime transaction policy/);
    const exports = spawnSync('/bin/bash', ['-c',
      'source "$CLAUDE_ENV_FILE"\nprintf "%s\\n" "$MANIFEST_PLUGIN_ROOT" "$MANIFEST_PLUGIN_DATA" "$NODE_PATH" "$MANIFEST_SESSION_ID"',
    ], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(exports.status, 0, exports.stderr);
    assert.deepEqual(exports.stdout.trimEnd().split('\n'), [root, data, join(data, 'node_modules'), 'spaced-path-session']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('policy-only invocation without CLAUDE_ENV_FILE or package.json skips stdin', () => {
  // Without an env file or a package to bootstrap (e.g. CI policy-syntax
  // check `bash session-start.sh`), HOOK_PAYLOAD is never used downstream
  // for either session exports or source gating, so we should NOT cat stdin
  // at all, avoiding both wasted work and a hang risk on an open-but-
  // unflushed pipe. Test by passing a payload that WOULD trigger the
  // session_id extraction; assert the hook emits policy and exits 0
  // without consuming stdin (we can't directly observe "didn't read";
  // we approximate by asserting the script completes promptly).
  const data = mkdtempSync(join(tmpdir(), 'session-start-data-'));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '/tmp',
    CLAUDE_PLUGIN_ROOT: data,
    CLAUDE_PLUGIN_DATA: data,
    // Deliberately NO CLAUDE_ENV_FILE.
  };
  try {
    const bashPath = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) || 'bash';
    const r = spawnSync(bashPath, [SCRIPT], {
      input: '{"session_id":"would-be-extracted","cwd":"/x"}',
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /cosmos_estimate_fee/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

function bootstrapFixture(t, setupSource) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest session bootstrap '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'plugin root');
  const data = join(dir, 'new runtime data');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(root, 'scripts/session-start.sh'));
  copyHostAdapter(root);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'scripts/setup-runtime.cjs'), setupSource);
  writeFileSync(join(root, 'scripts/migrate-credentials.cjs'), '');
  cpSync(join(__dirname, '../scripts/session-identity.cjs'), join(root, 'scripts/session-identity.cjs'));
  const env = { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_ENV_FILE: join(dir, 'session env') };
  const run = (extra = {}, input = '{"session_id":"bootstrap-session"}') => spawnSync('/bin/bash', ['-c', hooks.hooks.SessionStart[0].hooks[0].command], {
    env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 7000,
  });
  return { root, data, env, run };
}

function configureSessionIdentity(f, { behavior = 'normal' } = {}) {
  mkdirSync(f.data, { recursive: true });
  writeFileSync(join(f.data, 'config.json'), JSON.stringify({
    activeChain: 'testnet', gasPrice: '0.025umfx',
    chains: { testnet: { chainId: 'manifest-testnet-1' } },
    agent: { address: 'manifest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjpzgn4', keyPassword: 'PRIVATE_PASSWORD' },
  }));
  writeFileSync(join(f.root, 'scripts/start-server.cjs'), `
    const fs = require('node:fs');
    fs.appendFileSync(require('node:path').join(process.env.MANIFEST_PLUGIN_DATA, 'order'), 'identity\\n');
    console.error('PRIVATE_UPSTREAM_ERROR');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { capabilities: { tools: {} } } }));
      if (message.method !== 'tools/call') return;
      if (${JSON.stringify(behavior)} === 'malformed') { console.log('PRIVATE_UPSTREAM_OUTPUT'); return; }
      console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ module: 'bank', subcommand: 'balance',
          result: { balance: { denom: 'umfx', amount: '0' } } }) }],
      } }));
    });
  `);
}

function assertHookOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const policy = /cat <<'POLICY'\n([\s\S]*?)\nPOLICY/.exec(readFileSync(SCRIPT, 'utf8'))[1].trimEnd();
  assert.ok(output.hookSpecificOutput.additionalContext.startsWith(policy), 'complete canonical policy reaches model context');
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 10000);
  assert.doesNotMatch(result.stdout, /PRIVATE_PASSWORD|PRIVATE_UPSTREAM|MIGRATION_DIAGNOSTIC/);
  return output;
}

test('SessionStart delegates fresh runtime setup to the shared command with the persistent data path', (t) => {
  const f = bootstrapFixture(t, `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(process.env.MANIFEST_PLUGIN_DATA, { recursive: true });
    fs.writeFileSync(path.join(process.env.MANIFEST_PLUGIN_DATA, 'called.json'), JSON.stringify({
      argv: process.argv.slice(2), data: process.env.MANIFEST_PLUGIN_DATA,
    }));
    console.error('SETUP_DIAGNOSTIC_SENTINEL');
    console.log('ACCIDENTAL_SETUP_STDOUT');
  `);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.data, 'called.json'), 'utf8')), { argv: [], data: f.data });
  assert.match(result.stdout, /manifest-agent runtime transaction policy/);
  assert.doesNotMatch(result.stdout, /SETUP_DIAGNOSTIC_SENTINEL/);
  assert.match(result.stderr, /SETUP_DIAGNOSTIC_SENTINEL/);
  assert.match(result.stderr, /ACCIDENTAL_SETUP_STDOUT/);
  assertHookOutput(result);
  assert.equal(existsSync(join(f.root, 'node_modules')), false);
});

test('SessionStart propagates runtime setup failures after emitting policy and exports', (t) => {
  const f = bootstrapFixture(t, 'console.error("runtime repair failed"); process.exit(17);');
  const result = f.run();
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /runtime repair failed/);
  assert.match(result.stdout, /manifest-agent runtime transaction policy/);
  assert.match(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8'), /export MANIFEST_PLUGIN_DATA=/);
});

test('SessionStart delivers safe identity and faucet advice to both model and user after migration', (t) => {
  const f = bootstrapFixture(t, `
    const fs = require('node:fs');
    fs.mkdirSync(process.env.MANIFEST_PLUGIN_DATA, { recursive: true });
    fs.writeFileSync(require('node:path').join(process.env.MANIFEST_PLUGIN_DATA, 'order'), 'setup\\n');
  `);
  writeFileSync(join(f.root, 'scripts/migrate-credentials.cjs'), `
    require('node:fs').appendFileSync(require('node:path').join(process.env.MANIFEST_PLUGIN_DATA, 'order'), 'migration\\n');
    console.error('MIGRATION_DIAGNOSTIC');
    console.log('ACCIDENTAL_HELPER_STDOUT');
  `);
  configureSessionIdentity(f);
  const result = f.run({}, '{"session_id":"bootstrap-session","source":"startup"}');
  const output = assertHookOutput(result);
  assert.equal(readFileSync(join(f.data, 'order'), 'utf8'), 'setup\nmigration\nidentity\n');
  for (const text of [output.systemMessage, output.hookSpecificOutput.additionalContext]) {
    assert.match(text, /Agent address: manifest1/);
    assert.match(text, /Active chain: testnet \(manifest-testnet-1\)/);
    assert.match(text, /Gas-token balance: 0 umfx/);
    assert.match(text, /request_faucet/);
  }
  assert.doesNotMatch(result.stdout, /ACCIDENTAL_HELPER_STDOUT/);
  assert.match(result.stderr, /MIGRATION_DIAGNOSTIC/);
  assert.match(result.stderr, /ACCIDENTAL_HELPER_STDOUT/);
});

test('SessionStart treats failed balance diagnostics as optional after setup and exports', (t) => {
  const f = bootstrapFixture(t, '');
  configureSessionIdentity(f, { behavior: 'malformed' });
  const result = f.run();
  const output = assertHookOutput(result);
  assert.match(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8'), /export MANIFEST_PLUGIN_DATA=/);
  assert.match(output.systemMessage, /Gas-token balance unavailable \(invalid response\)/);
  assert.doesNotMatch(output.systemMessage, /request_faucet/);
});

test('SessionStart skips the balance query when credential migration fails without undoing setup', (t) => {
  const f = bootstrapFixture(t, '');
  configureSessionIdentity(f);
  writeFileSync(join(f.root, 'scripts/migrate-credentials.cjs'), 'console.error("Credential migration unavailable"); process.exit(1);');
  const result = f.run();
  const output = assertHookOutput(result);
  assert.match(result.stderr, /Credential migration unavailable/);
  for (const text of [output.systemMessage, output.hookSpecificOutput.additionalContext]) {
    assert.match(text, /Credential migration failed; wallet startup is blocked/);
    assert.match(text, /Unlock the OS credential store/);
    assert.match(text, /migrate-credentials\.cjs/);
    assert.match(text, /MANIFEST_CREDENTIAL_STORE=file/);
  }
  assert.equal(existsSync(join(f.data, 'order')), false, 'failed migration must not launch balance probe');
});

for (const source of ['resume', 'clear', 'compact', 'fork', 'future-source']) {
  test(`SessionStart source ${source} preserves policy and exports without migration or balance startup`, (t) => {
    const f = bootstrapFixture(t, '');
    configureSessionIdentity(f);
    writeFileSync(join(f.root, 'scripts/migrate-credentials.cjs'), 'throw new Error("MUST_NOT_MIGRATE");');
    const result = f.run({}, JSON.stringify({ source, session_id: 'retained-session' }));
    const output = assertHookOutput(result);
    assert.equal(output.systemMessage, undefined);
    assert.match(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8'), /MANIFEST_SESSION_ID=retained-session/);
    assert.match(readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8'), /export MANIFEST_PLUGIN_DATA=/);
    assert.equal(existsSync(join(f.data, 'order')), false);
    assert.doesNotMatch(result.stderr, /MUST_NOT_MIGRATE/);
  });
}

test('SessionStart reads source even when the host omits CLAUDE_ENV_FILE', (t) => {
  const f = bootstrapFixture(t, '');
  configureSessionIdentity(f);
  const output = assertHookOutput(f.run({ CLAUDE_ENV_FILE: '' }, '{"source":"resume"}'));
  assert.equal(output.systemMessage, undefined);
  assert.equal(existsSync(join(f.data, 'order')), false);
});

test('SessionStart reports missing Node before running dependency setup', (t) => {
  const f = bootstrapFixture(t, 'throw new Error("must not execute");');
  withShimWithoutJq((shim) => {
    rmSync(join(shim, 'node'));
    const result = f.run({ PATH: shim });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node 22\.19\.0\+ is required/);
    assert.doesNotMatch(result.stderr, /must not execute/);
    assert.equal(existsSync(f.data), false);
  });
});

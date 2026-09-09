'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, cpSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const hooks = require('../hooks/hooks.json');
const { decidePermission } = require('../scripts/pre-tool-use.cjs');

const ROOT = join(__dirname, '..');
const PREFIX = 'mcp__plugin_manifest-agent_';
const name = (server, tool) => `${PREFIX}manifest-${server}__${tool}`;
const matches = (tool) => hooks.hooks.PreToolUse.some(({ matcher }) => new RegExp(matcher).test(tool));
const event = (tool, tool_input = {}, permission_mode = 'default') => ({
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input, permission_mode,
});

function runHook(input, { root = ROOT, env = {} } = {}) {
  // Exercise the shipped command, including plugin-root substitution/quoting.
  const command = hooks.hooks.PreToolUse[0].hooks[0].command
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  return spawnSync('/bin/bash', ['-c', command], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, ...env },
  });
}

for (const [server, tool] of [
  ['chain', 'cosmos_tx'], ['cosmwasm', 'convert_mfx_to_pwr'],
  ['fred', 'deploy_app'], ['fred', 'restart_app'], ['fred', 'restore_app'], ['fred', 'update_app'],
  ['lease', 'fund_credit'], ['lease', 'close_lease'], ['lease', 'set_item_custom_domain'],
  ['agent', 'deploy_app_orchestrated'], ['agent', 'manage_domain_orchestrated'],
  ['agent', 'close_lease_orchestrated'],
]) {
  test(`installed plugin ${server}/${tool} requests host permission`, () => {
    const full = name(server, tool);
    assert.ok(matches(full), `host must dispatch the hook for ${full}`);
    const result = runHook(event(full));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
}

test('read-only tools, faucet and unrelated plugins are not matched', () => {
  for (const full of [
    name('chain', 'cosmos_query'), name('chain', 'cosmos_estimate_fee'), name('chain', 'request_faucet'),
    name('fred', 'app_status'), name('fred', 'build_manifest_preview'),
    name('lease', 'lease_by_custom_domain'), name('agent', 'troubleshoot_deployment_orchestrated'),
    'mcp__plugin_another_manifest-fred__deploy_app', 'mcp__manifest-fred__deploy_app',
    `${name('fred', 'deploy_app')}_preview`, `prefix_${name('fred', 'deploy_app')}`,
  ]) {
    assert.equal(matches(full), false, full);
    assert.equal(decidePermission(event(full)), 'defer', 'a non-match must never override host permissions');
  }
});

test('dedicated domain lookup defers while every manage-domain action stays gated', () => {
  const lookup = name('agent', 'lookup_custom_domain_orchestrated');
  assert.equal(matches(lookup), false);
  const result = runHook(event(lookup, { fqdn: 'example.com' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'read-only lookup must not override host permission');
  const full = name('agent', 'manage_domain_orchestrated');
  for (const action of ['lookup', 'set', 'clear', '', null, ['lookup'], { action: 'lookup' }]) {
    assert.equal(decidePermission(event(full, { action })), 'ask-orchestrated');
  }
});

test('host permission precedes the orchestrated plan, with no claim of per-inner-call hooks', () => {
  const result = runHook(event(name('agent', 'deploy_app_orchestrated')));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.match(output.permissionDecisionReason, /then request confirmation/);
  assert.doesNotMatch(output.permissionDecisionReason, /showed|per transaction|inner/);
});

test('the hook emits ask even for host modes that ordinarily suppress prompts', () => {
  // This checks the policy output, not how any particular host implements ask.
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']) {
    const result = runHook(event(name('fred', 'restart_app'), {}, mode));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
  }
});

test('malformed hook input is denied without echoing secrets', () => {
  for (const input of ['', 'not-json SECRET_SENTINEL', 'null', '[]', '{}', JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: name('chain', 'cosmos_tx'),
    tool_input: { mnemonic: 'SECRET_SENTINEL' },
  })]) {
    const result = runHook(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/);
  }
});

test('valid tool arguments never appear in the permission response', () => {
  const result = runHook(event(name('agent', 'deploy_app_orchestrated'), {
    spec: { env: { PASSWORD: 'SECRET_SENTINEL' } },
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /PASSWORD|SECRET_SENTINEL/);
});

test('missing Node emits a shell fallback deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-hook-path-'));
  try {
    // Invoke Bash directly because the shipped shebang resolves bash via PATH.
    const result = spawnSync('/bin/bash', [join(ROOT, 'scripts/pre-tool-use.sh')], {
      input: JSON.stringify(event(name('chain', 'cosmos_tx'))), encoding: 'utf8',
      env: { PATH: dir }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a crashing handler cannot emit a partial allow ahead of the fallback deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-hook-node-'));
  try {
    writeFileSync(join(dir, 'node'), '#!/bin/bash\nprintf \'{"permissionDecision":"allow"}\'\nexit 1\n');
    chmodSync(join(dir, 'node'), 0o755);
    const result = runHook(event(name('chain', 'cosmos_tx')), { env: { PATH: `${dir}:/usr/bin:/bin` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.doesNotMatch(result.stdout, /allow/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inherited Node preloads cannot run or contaminate the host decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-hook-preload-'));
  try {
    const marker = join(dir, 'preload-ran');
    const preload = join(dir, 'banner.cjs');
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nconsole.log('SECRET_SENTINEL');\n`);
    for (const required of [preload, 'banner.cjs']) {
      const result = runHook(event(name('chain', 'cosmos_tx')), {
        env: { NODE_OPTIONS: `--require ${required}`, NODE_PATH: dir },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
      assert.equal(existsSync(marker), false, 'the inherited preload must never execute');
      assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('successful child output must be a known token before the shell emits any host JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-hook-output-'));
  try {
    const shim = join(dir, 'node');
    const malformed = '{"hookSpecificOutput":{not JSON}}';
    const json = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}';
    for (const output of ['', 'ask', malformed, json, 'ask-direct\nSECRET_SENTINEL',
      'SECRET_SENTINEL\nask-direct', 'ask-orchestrated SECRET_SENTINEL}', 'defer\nSECRET_SENTINEL']) {
      // Successful interpreter shim: this must exercise output validation,
      // not the existing nonzero-exit fallback.
      writeFileSync(shim, `#!/bin/bash\nprintf '%s' "$MANIFEST_TEST_NODE_OUTPUT"\n`);
      chmodSync(shim, 0o755);
      const result = runHook(event(name('chain', 'cosmos_tx')), {
        env: { PATH: `${dir}:${process.env.PATH}`, MANIFEST_TEST_NODE_OUTPUT: output },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL|not JSON|allow/);
      assert.equal(result.stdout.trim().split('\n').length, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or malformed matcher configuration is denied, never compiled as an empty regexp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-hook-config-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'hooks'));
    for (const file of ['pre-tool-use.sh', 'pre-tool-use.cjs']) {
      cpSync(join(ROOT, 'scripts', file), join(dir, 'scripts', file));
    }
    for (const pre of [undefined, [], [null], [{}], [{ matcher: null }], [{ matcher: '' }], [{ matcher: '[' }]]) {
      writeFileSync(join(dir, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: pre } }));
      const result = runHook(event(name('chain', 'cosmos_tx')), { root: dir });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the registered hook command works from a plugin path containing spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest hook '));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'hooks'));
    for (const file of ['scripts/pre-tool-use.sh', 'scripts/pre-tool-use.cjs', 'hooks/hooks.json']) {
      cpSync(join(ROOT, file), join(dir, file));
    }
    const result = runHook(event(name('chain', 'cosmos_tx')), { root: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

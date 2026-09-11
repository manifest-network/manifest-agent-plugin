'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolveHost, shellExports } = require('../scripts/_host.cjs');

test('Claude adapter preserves its upgrade data directory; Codex ignores all Claude lifecycle and state variables', () => {
  const env = { CLAUDE_PLUGIN_ROOT: '/old/cache', CLAUDE_PLUGIN_DATA: '/old/claude/data',
    MANIFEST_PLUGIN_DATA: '/different/session', MANIFEST_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-thread' };
  const options = { env, home: '/fixture/home', pluginRoot: '/new/cache/manifest-agent' };
  const claude = resolveHost('claude', options);
  const codex = resolveHost('codex', options);
  assert.equal(claude.dataDir, '/old/claude/data');
  assert.equal(codex.dataDir, '/fixture/home/.local/share/manifest-agent/codex');
  assert.equal(codex.env.MANIFEST_SESSION_ID, 'codex-thread');
  assert.equal(claude.env.MANIFEST_SESSION_ID, 'claude-session');
  assert.equal(codex.env.NODE_PATH, `${codex.dataDir}/node_modules`);
  assert.equal(codex.pluginRoot, options.pluginRoot);
  assert.equal(env.MANIFEST_PLUGIN_DATA, '/different/session');
});

test('Codex supports explicit absolute data overrides and XDG without tying data to package versions', () => {
  assert.equal(resolveHost('codex', { env: { XDG_DATA_HOME: '/xdg' } }).dataDir, '/xdg/manifest-agent/codex');
  assert.equal(resolveHost('codex', { env: { MANIFEST_CODEX_DATA: '/private/codex' } }).dataDir, '/private/codex');
  assert.equal(resolveHost('codex', { env: { MANIFEST_CODEX_DATA: '/private/codex', XDG_DATA_HOME: 'unused-relative' } }).dataDir, '/private/codex');
  assert.equal(resolveHost('codex', { env: {} }).env.MANIFEST_SESSION_ID, '');
  assert.equal(resolveHost('claude', { env: { MANIFEST_PLUGIN_DATA: '/legacy/manual' } }).dataDir, '/legacy/manual');
});

test('missing or ambiguous host paths fail with a useful diagnostic', () => {
  assert.throws(() => resolveHost('claude', { env: {} }), /Claude plugin data is missing/);
  assert.throws(() => resolveHost('unknown'), /Host must be/);
  for (const value of ['relative', '/nul\0path', 4]) {
    assert.throws(() => resolveHost('codex', { env: { MANIFEST_CODEX_DATA: value } }), /absolute path/);
  }
  assert.throws(() => resolveHost('codex', { env: { XDG_DATA_HOME: 'relative' } }), /XDG_DATA_HOME/);
  assert.throws(() => resolveHost('codex', { pluginRoot: 'relative' }), /Plugin root/);
});

test('shell exports round-trip spaces, quotes, newlines, substitutions and backticks as inert data', () => {
  const value = '/fixture/it\'s $(printf injected) `printf injected`\nnext';
  const script = shellExports({ MANIFEST_TEST_PATH: value })
    + 'node -e \'process.stdout.write(JSON.stringify(process.env.MANIFEST_TEST_PATH))\'';
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), value);
  assert.throws(() => shellExports({ 'INVALID;KEY': 'x' }), /Invalid environment/);
  assert.throws(() => shellExports({ PATH: 'x\0' }), /Invalid environment/);
});

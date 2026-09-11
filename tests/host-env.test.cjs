'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const script = join(__dirname, '../scripts/host-env.cjs');
const env = { PATH: process.env.PATH, MANIFEST_CODEX_DATA: '/fixture/codex' };

test('host-env CLI resolves Codex without reading config and emits either JSON or shell exports', () => {
  for (const args of [['codex'], ['codex', '--shell']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (args.length === 1) assert.equal(JSON.parse(result.stdout).dataDir, '/fixture/codex');
    else assert.match(result.stdout, /export MANIFEST_PLUGIN_DATA='\/fixture\/codex'/);
    assert.doesNotMatch(result.stdout, /password|mnemonic|keyFile/);
  }
});

test('host-env CLI rejects unknown hosts, flags and missing arguments', () => {
  for (const args of [[], ['other'], ['codex', '--bad'], ['codex', '--shell', 'extra'], ['claude']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:|Host must be|Claude plugin data/);
  }
});

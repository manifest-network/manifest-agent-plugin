'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolvePassword } = require('../scripts/_credentials.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'manifest-migrate-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'migrate-credentials.cjs'), ...args], {
    env: { ...process.env, MANIFEST_PLUGIN_DATA: dir, MANIFEST_CREDENTIAL_STORE: 'file', ...extraEnv },
    encoding: 'utf8', timeout: 45000,
  });
}

test('migration CLI skips missing configs silently and rejects extra arguments', (t) => {
  const dir = fixture(t);
  const skipped = run(dir);
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stdout, '');
  assert.equal(skipped.stderr, '');
  const misuse = run(dir, ['--secret=TEST_ONLY_SENTINEL']);
  assert.equal(misuse.status, 1);
  assert.match(misuse.stderr, /Usage:/);
  assert.equal(misuse.stderr.includes('TEST_ONLY_SENTINEL'), false);
  assert.equal(run('', [], { MANIFEST_PLUGIN_DATA: '' }).status, 1);
});

test('migration CLI saves a usable reference, scrubs plaintext and emits one stderr breadcrumb', (t) => {
  const dir = fixture(t);
  const sentinel = 'TEST_ONLY_MIGRATION_PASSWORD';
  const config = { agent: { keyFile: join(dir, 'wallet.json'), keyPassword: sentinel } };
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /credential migrated/);
  assert.equal(result.stderr.includes(sentinel), false);
  const migrated = JSON.parse(fs.readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(migrated.agent, 'keyPassword'), false);
  assert.equal(resolvePassword(migrated, dir), sentinel);
  assert.equal(run(dir).stderr, '');
});

test('migration CLI never leaks malformed config content and keeps the original bytes', (t) => {
  const dir = fixture(t);
  const contents = '{"agent":{"keyPassword":"TEST_ONLY_BROKEN_SECRET';
  fs.writeFileSync(join(dir, 'config.json'), contents);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('TEST_ONLY_BROKEN_SECRET'), false);
  assert.match(result.stderr, /Invalid config.json/);
  assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), contents);
});

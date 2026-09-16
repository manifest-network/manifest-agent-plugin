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
  const automatic = run(dir, ['--automatic']);
  assert.equal(automatic.status, 0);
  assert.equal(automatic.stdout + automatic.stderr, '');
  const misuse = run(dir, ['--secret=TEST_ONLY_SENTINEL']);
  assert.equal(misuse.status, 1);
  assert.match(misuse.stderr, /Usage:/);
  assert.equal(misuse.stderr.includes('TEST_ONLY_SENTINEL'), false);
  assert.equal(run(dir, ['--automatic', '--automatic']).status, 1);
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

test('manual migration retries an unlocked store immediately while automatic startup retains its cooldown', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fixture(t);
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'secret-tool'), `#!${process.execPath}\n
    const fs = require('node:fs');
    const { join } = require('node:path');
    const dir = ${JSON.stringify(dir)};
    fs.appendFileSync(join(dir, 'attempts'), process.argv[2] + '\\n');
    if (!fs.existsSync(join(dir, 'unlocked'))) process.exit(1);
    if (process.argv[2] === 'store') fs.writeFileSync(join(dir, 'stored-payload'), fs.readFileSync(0));
    else process.stdout.write(fs.readFileSync(join(dir, 'stored-payload')));
  `, { mode: 0o700 });
  const legacy = JSON.stringify({ agent: { keyFile: 'wallet.json', keyPassword: 'TEST_ONLY_MANUAL_RETRY_PASSWORD' } });
  fs.writeFileSync(join(dir, 'config.json'), legacy);
  const env = { MANIFEST_CREDENTIAL_STORE: 'auto', PATH: bin };
  const failed = run(dir, ['--automatic'], env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Credential access failed \(libsecret\)/);
  assert.equal(fs.readFileSync(join(dir, 'attempts'), 'utf8'), 'store\n');
  fs.writeFileSync(join(dir, 'unlocked'), 'yes');
  const automatic = run(dir, ['--automatic'], env);
  assert.equal(automatic.status, 1);
  assert.match(automatic.stderr, /retry is paused/);
  assert.equal(fs.readFileSync(join(dir, 'attempts'), 'utf8'), 'store\n');
  assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), legacy);
  const manual = run(dir, [], env);
  assert.equal(manual.status, 0, manual.stderr);
  assert.equal(fs.readFileSync(join(dir, 'attempts'), 'utf8'), 'store\nstore\nlookup\n');
  const migrated = JSON.parse(fs.readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(resolvePassword(migrated, dir, { env: { ...process.env, ...env } }), 'TEST_ONLY_MANUAL_RETRY_PASSWORD');
  assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
  assert.equal(manual.stdout, '');
  assert.doesNotMatch(failed.stderr + automatic.stderr + manual.stderr, /TEST_ONLY_MANUAL_RETRY_PASSWORD/);
});

test('manual and automatic migration report legacy shape recovery without mutating config', (t) => {
  const dir = fixture(t);
  for (const agent of [{ keyPassword: 'TEST_ONLY_INVALID_LEGACY' }, { keyFile: 'wallet.json', keyPassword: 12 }]) {
    const contents = JSON.stringify({ agent });
    fs.writeFileSync(join(dir, 'config.json'), contents);
    for (const args of [[], ['--automatic']]) {
      const result = run(dir, args);
      assert.equal(result.status, args.length ? 2 : 1);
      assert.ok(result.stderr.includes(join(dir, 'config.json')));
      assert.match(result.stderr, /Repair the previous config.*move it aside as a private backup/);
      assert.doesNotMatch(result.stderr, /TEST_ONLY_INVALID_LEGACY/);
      assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), contents);
      assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
    }
  }
});

test('only automatic migration uses status 2 for local credential validation', (t) => {
  const dir = fixture(t);
  const id = `${'a'.repeat(24)}-00000000-0000-4000-8000-000000000000`;
  const foreignBackend = process.platform === 'linux' ? 'keychain' : 'libsecret';
  const cases = [
    '{"agent":',
    JSON.stringify({ agent: { keyFile: 'wallet.json', keyPassword: 'TEST_ONLY_SECRET', keyPasswordRef: null } }),
    JSON.stringify({ agent: { keyFile: 'wallet.json', keyPassword: 'TEST_ONLY_SECRET', keyPasswordRef: { backend: foreignBackend, id } } }),
    JSON.stringify({ agent: { keyFile: 'wallet.json', keyPassword: 'x'.repeat(9000) } }),
  ];
  for (const original of cases) {
    fs.writeFileSync(join(dir, 'config.json'), original);
    for (const args of [[], ['--automatic']]) {
      const result = run(dir, args, { MANIFEST_CREDENTIAL_STORE: 'auto' });
      assert.equal(result.status, args.length ? 2 : 1, result.stderr);
      assert.doesNotMatch(result.stderr, /TEST_ONLY_SECRET/);
      assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), original);
      assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
    }
  }
});

test('automatic migration distinguishes corrupt existing native data from failed fresh verification', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fixture(t);
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'secret-tool'), `#!${process.execPath}\nprocess.stdout.write('invalid-native-payload!');`, { mode: 0o700 });
  const ref = { backend: 'libsecret', id: `${'a'.repeat(24)}-00000000-0000-4000-8000-000000000000` };
  const env = { PATH: bin, MANIFEST_CREDENTIAL_STORE: 'auto' };
  const legacy = { agent: { keyFile: 'wallet.json', keyPassword: 'TEST_ONLY_SECRET', keyPasswordRef: ref } };
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy));
  for (const args of [[], ['--automatic']]) {
    const result = run(dir, args, env);
    assert.equal(result.status, args.length ? 2 : 1, result.stderr);
    assert.match(result.stderr, /stored credential is invalid/);
    assert.doesNotMatch(result.stderr, /Unlock|TEST_ONLY_SECRET/);
    assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
  }
  delete legacy.agent.keyPasswordRef;
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy));
  const fresh = run(dir, ['--automatic'], env);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /Credential verification failed/);
  assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), true);
});

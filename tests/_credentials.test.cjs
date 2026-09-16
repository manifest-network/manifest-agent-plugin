'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { storePassword, resolvePassword, migrateConfig, withConfigLock, readConfig } = require('../scripts/_credentials.cjs');

const fileOptions = { env: { MANIFEST_CREDENTIAL_STORE: 'file' } };
const SENTINEL = 'TEST_ONLY_PASSWORD_with quotes "\'\\ $()\nπ\u0000';

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'manifest-credentials-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(dir, password = SENTINEL) {
  const value = { activeChain: 'testnet', gasPrice: '1umfx', agent: { keyFile: join(dir, 'keys', 'agent.json'), keyPassword: password, address: 'manifest1fixture' } };
  fs.mkdirSync(join(dir, 'keys'));
  fs.writeFileSync(value.agent.keyFile, 'encrypted wallet fixture');
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(value));
  return value;
}

function nativeFixture(platform, changes = {}) {
  const entries = new Map();
  const calls = [];
  const options = { platform, env: {}, spawnSync(command, args, opts) {
    calls.push({ command, args, opts });
    assert.equal(opts.stdio.join(','), 'pipe,pipe,pipe');
    assert.equal(opts.windowsHide, true);
    let id, payload, store;
    if (platform === 'linux') {
      assert.equal(command, 'secret-tool');
      id = args.at(-1);
      store = args[0] === 'store';
      payload = opts.input;
    } else if (platform === 'darwin') {
      assert.equal(command, '/usr/bin/security');
      store = args[0] === '-i';
      if (store) {
        assert.deepEqual(args, ['-i', '-q']);
        const match = opts.input.match(/^add-generic-password -a (\S+) -s org\.manifest-network\.manifest-agent -w (\S+)\n$/);
        assert.ok(match, 'one safe interactive command');
        [, id, payload] = match;
      } else id = args[args.indexOf('-a') + 1];
    } else {
      assert.match(command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.ok(args.includes('-NonInteractive'));
      assert.equal(args[args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
      assert.match(args.at(-1), /_wincred\.ps1$/);
      const request = JSON.parse(opts.input);
      id = request.target;
      store = request.operation === 'store';
      payload = request.payload;
    }
    assert.ok(!JSON.stringify([command, args]).includes(SENTINEL));
    if (payload) assert.ok(!JSON.stringify([command, args]).includes(payload), 'encoded secret must also stay off argv');
    if (store) { entries.set(id, payload); return { status: 0, stdout: '', stderr: SENTINEL }; }
    return { status: 0, stdout: `${entries.get(id)}\n`, stderr: SENTINEL };
  }, ...changes };
  return { options, entries, calls };
}

for (const platform of ['linux', 'darwin', 'win32']) {
  for (const password of [SENTINEL, '']) {
    test(`${platform}: native store/readback/resolve preserves ${password ? 'arbitrary' : 'empty'} passwords through stdin`, (t) => {
      const dir = fixture(t);
      const fake = nativeFixture(platform);
      const ref = storePassword(dir, '/keys/fixture.json', password, fake.options);
      assert.equal(ref.backend, { linux: 'libsecret', darwin: 'keychain', win32: 'wincred' }[platform]);
      assert.equal(resolvePassword({ agent: { keyPasswordRef: ref } }, dir, fake.options), password);
      assert.equal(fake.calls.length, 3);
      assert.deepEqual(fs.readdirSync(dir), [], 'native mode writes no secret to plugin files');
    });
  }
}

test('file backend requires explicit selection and creates private separate credentials', (t) => {
  const dir = fixture(t);
  const ref = storePassword(dir, 'wallet.json', SENTINEL, fileOptions);
  assert.equal(ref.backend, 'file');
  assert.equal(resolvePassword({ agent: { keyPasswordRef: ref } }, dir), SENTINEL);
  const target = join(dir, 'credentials', `${ref.id}.json`);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(join(dir, 'credentials')).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(join(dir, 'config.json')), false);
  assert.equal(JSON.stringify(ref).includes(SENTINEL), false);
});

test('new credentials do not overwrite a prior password for the same wallet', (t) => {
  const dir = fixture(t);
  const first = storePassword(dir, 'wallet.json', 'old password', fileOptions);
  const next = storePassword(dir, 'wallet.json', 'new password', fileOptions);
  assert.notEqual(first.id, next.id);
  assert.equal(resolvePassword({ agent: { keyPasswordRef: first } }, dir), 'old password');
  assert.equal(resolvePassword({ agent: { keyPasswordRef: next } }, dir), 'new password');
});

test('Windows file fallback restricts ACLs before creating or reading a secret', (t) => {
  const dir = fixture(t);
  const operations = [];
  const options = { ...fileOptions, platform: 'win32', spawnSync(command, args, opts) {
    const request = JSON.parse(opts.input);
    operations.push(request.operation);
    assert.ok(!opts.input.includes(SENTINEL));
    if (request.operation === 'protect-directory') assert.deepEqual(fs.readdirSync(request.target), []);
    return { status: 0, stdout: '' };
  } };
  const ref = storePassword(dir, 'wallet.json', SENTINEL, options);
  assert.equal(resolvePassword({ agent: { keyPasswordRef: ref } }, dir, options), SENTINEL);
  assert.deepEqual(operations, ['protect-directory', 'protect-file', 'protect-file']);
  const other = fixture(t);
  assert.throws(() => storePassword(other, 'wallet.json', SENTINEL, {
    ...options, spawnSync: () => ({ status: 1, stderr: SENTINEL }),
  }), /Credential access failed/);
  assert.deepEqual(fs.readdirSync(join(other, 'credentials')), [], 'failed ACL must prevent secret creation');
});

test('backend errors never include native output or exception text and never downgrade', (t) => {
  const dir = fixture(t);
  for (const spawnSync of [() => ({ status: 1, stdout: SENTINEL, stderr: SENTINEL }), () => { throw new Error(SENTINEL); }, () => ({ status: 0, error: new Error(SENTINEL) }), () => ({ status: null, signal: 'SIGTERM' })]) {
    assert.throws(() => storePassword(dir, 'wallet.json', SENTINEL, { platform: 'linux', env: {}, spawnSync }), (error) => {
      assert.match(error.message, /Credential access failed \(libsecret\)/);
      assert.equal(error.message.includes(SENTINEL), false);
      return true;
    });
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a stored native reference ignores file preference and never uses legacy plaintext fallback', (t) => {
  const dir = fixture(t);
  const fake = nativeFixture('linux');
  const ref = storePassword(dir, 'wallet.json', SENTINEL, fake.options);
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref, keyPassword: 'fallback secret' } }, dir, {
    platform: 'linux', env: fileOptions.env, spawnSync: () => ({ status: 1, stderr: SENTINEL }),
  }), /Credential access failed/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('readback mismatch prevents credential commit', (t) => {
  const dir = fixture(t);
  assert.throws(() => storePassword(dir, 'wallet.json', SENTINEL, {
    platform: 'linux', env: {}, spawnSync: () => ({ status: 0, stdout: Buffer.from(JSON.stringify({ version: 1, password: 'wrong' })).toString('base64') }),
  }), /verification failed/);
});

test('malformed native payload is sanitized, including JSON parser diagnostics', (t) => {
  const dir = fixture(t);
  for (const output of ['', 'not base64!', Buffer.from(SENTINEL).toString('base64'), Buffer.from('{"version":1,"password":null}').toString('base64')]) {
    assert.throws(() => storePassword(dir, 'wallet.json', SENTINEL, {
      platform: 'linux', env: {}, spawnSync: () => ({ status: 0, stdout: output }),
    }), (error) => error.message.includes('read failed') && !error.message.includes(SENTINEL));
  }
});

test('invalid reference shape or path traversal never calls native tools or reads arbitrary files', (t) => {
  const dir = fixture(t);
  for (const ref of [undefined, null, [], 'secret', {}, { backend: 'file', id: '../config' }, { backend: 'other', id: 'secret' }]) {
    assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir, { spawnSync: () => assert.fail('must not spawn') }), /Invalid agent.keyPasswordRef/);
  }
});

test('unsupported platform, invalid preference, non-string password and missing wallet reject clearly', (t) => {
  const dir = fixture(t);
  assert.throws(() => storePassword(dir, 'wallet', 'secret', { platform: 'freebsd', env: {} }), /No native credential store/);
  assert.throws(() => storePassword(dir, 'wallet', 'secret', { env: { MANIFEST_CREDENTIAL_STORE: 'silent-fallback' } }), /must be auto or file/);
  assert.throws(() => storePassword(dir, 'wallet', null, fileOptions), /must be a string/);
  assert.throws(() => storePassword(dir, '', 'secret', fileOptions), /keyFile is required/);
});

test('existing native reference on another OS fails without fallback', (t) => {
  const dir = fixture(t);
  const fake = nativeFixture('linux');
  const ref = storePassword(dir, 'wallet', 'secret', fake.options);
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir, { platform: 'darwin', env: fileOptions.env }), /different operating system/);
});

test('oversized native payloads reject before spawning or truncating', (t) => {
  const dir = fixture(t);
  for (const platform of ['darwin', 'win32']) {
    assert.throws(() => storePassword(dir, 'wallet', 'p'.repeat(4000), {
      platform, env: {}, spawnSync: () => assert.fail('must not spawn'),
    }), /too long/);
  }
});

test('file backend rejects loose permissions, symlink credentials and missing entries', (t) => {
  const dir = fixture(t);
  const ref = storePassword(dir, 'wallet', SENTINEL, fileOptions);
  const target = join(dir, 'credentials', `${ref.id}.json`);
  fs.chmodSync(target, 0o644);
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir), /read failed/);
  fs.unlinkSync(target);
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir), /read failed/);
  fs.writeFileSync(join(dir, 'other'), '{}');
  fs.symlinkSync(join(dir, 'other'), target);
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir), /read failed/);
  fs.rmSync(join(dir, 'credentials'), { recursive: true });
  fs.mkdirSync(join(dir, 'outside'));
  fs.symlinkSync(join(dir, 'outside'), join(dir, 'credentials'));
  assert.throws(() => storePassword(dir, 'wallet', SENTINEL, fileOptions), /access failed/);
});

test('migration scrubs atomically after verification and records one durable breadcrumb', (t) => {
  const dir = fixture(t);
  const old = config(dir);
  const logs = [];
  const result = migrateConfig(dir, { ...fileOptions, log: (line) => logs.push(line) });
  assert.equal(Object.hasOwn(result.agent, 'keyPassword'), false);
  assert.equal(resolvePassword(result, dir), SENTINEL);
  assert.equal(result.credentialMigration.version, 1);
  assert.equal(result.credentialMigration.backend, 'file');
  assert.equal(result.activeChain, old.activeChain);
  assert.equal(fs.readFileSync(old.agent.keyFile, 'utf8'), 'encrypted wallet fixture');
  const after = fs.readFileSync(join(dir, 'config.json'), 'utf8');
  assert.equal(after.includes(SENTINEL), false);
  assert.equal(after.includes('keyPassword"'), false);
  assert.equal(fs.statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  migrateConfig(dir, { ...fileOptions, log: (line) => logs.push(line) });
  assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), after);
  assert.equal(fs.readdirSync(join(dir, 'credentials')).length, 1);
  assert.equal(logs.length, 1);
});

test('migration preserves empty legacy passwords', (t) => {
  const dir = fixture(t);
  config(dir, '');
  const result = migrateConfig(dir, { ...fileOptions, log: () => {} });
  assert.equal(resolvePassword(result, dir), '');
});

test('failed write, failed verification and failed atomic commit preserve legacy config and wallet', (t) => {
  for (const mode of ['write', 'verification', 'commit']) {
    const dir = fs.mkdtempSync(join(fixture(t), `${mode}-`));
    const old = config(dir);
    const before = fs.readFileSync(join(dir, 'config.json'));
    let options;
    if (mode === 'commit') options = { ...fileOptions, atomicWrite: () => { throw new Error(SENTINEL); } };
    else options = { platform: 'linux', env: {}, spawnSync: () => mode === 'write'
      ? { status: 1, stderr: SENTINEL }
      : { status: 0, stdout: Buffer.from('{"version":1,"password":"wrong"}').toString('base64') } };
    assert.throws(() => migrateConfig(dir, options), (error) => !error.message.includes(SENTINEL));
    assert.deepEqual(fs.readFileSync(join(dir, 'config.json')), before);
    assert.equal(fs.readFileSync(old.agent.keyFile, 'utf8'), 'encrypted wallet fixture');
    assert.deepEqual(fs.readdirSync(join(dir, '.config.lock')), []);
  }
});

test('partially transitioned legacy config reuses matching reference and rejects broken reference', (t) => {
  const dir = fixture(t);
  const old = config(dir);
  old.agent.keyPasswordRef = storePassword(dir, old.agent.keyFile, SENTINEL, fileOptions);
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(old));
  const result = migrateConfig(dir, { ...fileOptions, log: () => {} });
  assert.deepEqual(result.agent.keyPasswordRef, old.agent.keyPasswordRef);
  assert.equal(fs.readdirSync(join(dir, 'credentials')).length, 1);
  old.agent.keyPassword = 'conflicting secret';
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(old));
  assert.throws(() => migrateConfig(dir, fileOptions), /does not match/);
  assert.equal(readConfig(dir).agent.keyPassword, 'conflicting secret');
  old.agent.keyPasswordRef = null;
  fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(old));
  assert.throws(() => migrateConfig(dir, fileOptions), /Invalid agent.keyPasswordRef/);
});

test('missing config skips without creating a directory; malformed config never repeats secrets', (t) => {
  const dir = fixture(t);
  const absent = join(dir, 'absent');
  assert.equal(migrateConfig(absent), null);
  assert.equal(fs.existsSync(absent), false);
  fs.writeFileSync(join(dir, 'config.json'), `{"agent":{"keyPassword":${SENTINEL}}`);
  assert.throws(() => migrateConfig(dir), (error) => error.message === 'Invalid config.json: expected a JSON object.');
  fs.writeFileSync(join(dir, 'config.json'), '{"agent":{"keyPassword":42}}');
  assert.throws(() => migrateConfig(dir), /expected a string/);
});

test('configuration lock releases on failure and times out without stealing a live owner', (t) => {
  const dir = fixture(t);
  assert.throws(() => withConfigLock(dir, () => { throw new Error('fixture error'); }), /fixture error/);
  assert.deepEqual(fs.readdirSync(join(dir, '.config.lock')), []);
  withConfigLock(dir, () => {
    assert.throws(() => withConfigLock(dir, () => assert.fail('must not acquire'), { lockTimeoutMs: 25 }), /Timed out/);
    assert.equal(fs.existsSync(join(dir, '.config.lock')), true);
  });
});

test('configuration lock recovers a dead process without discarding config', (t) => {
  const dir = fixture(t);
  config(dir);
  const lock = join(dir, '.config.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(join(lock, '2147483647-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner', ticket: 1 }));
  const result = migrateConfig(dir, { ...fileOptions, log: () => {}, lockTimeoutMs: 1000 });
  assert.equal(resolvePassword(result, dir), SENTINEL);
  assert.deepEqual(fs.readdirSync(lock), []);
});

test('concurrent migration processes commit once and retain one usable credential', async (t) => {
  const dir = fixture(t);
  config(dir);
  const script = join(__dirname, '..', 'scripts', 'migrate-credentials.cjs');
  const results = await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, MANIFEST_PLUGIN_DATA: dir, MANIFEST_CREDENTIAL_STORE: 'file' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stderr, stdout }));
  })));
  assert.ok(results.every((result) => result.status === 0 && result.stdout === ''), JSON.stringify(results));
  assert.equal(results.filter((result) => result.stderr.includes('credential migrated')).length, 1);
  assert.equal(fs.readdirSync(join(dir, 'credentials')).length, 1);
  assert.equal(resolvePassword(readConfig(dir), dir), SENTINEL);
});

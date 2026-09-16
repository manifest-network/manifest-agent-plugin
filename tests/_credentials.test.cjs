'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { storePassword, resolvePassword, migrateConfig, withConfigLock, readConfig } = require('../scripts/_credentials.cjs');
const { processStartTime } = require('../scripts/_runtime.cjs');

const fileOptions = { env: { MANIFEST_CREDENTIAL_STORE: 'file' } };
const SENTINEL = 'TEST_ONLY_PASSWORD_with quotes "\'\\ $()\nπ\u0000';

function fixture(t) {
  const dir = fs.mkdtempSync(join(process.env.MANIFEST_LOCK_TEST_ROOT || tmpdir(), 'manifest-credentials-test-'));
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
  }), /Credential access failed \(file\).*private credentials directory/);
  assert.deepEqual(fs.readdirSync(join(other, 'credentials')), [], 'failed ACL must prevent secret creation');
  assert.throws(() => resolvePassword({ agent: { keyPasswordRef: ref } }, dir, {
    ...options, spawnSync: () => ({ status: 1, stderr: SENTINEL }),
  }), /Credential access failed \(file\).*private credentials directory/);
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
    assert.equal(fs.existsSync(join(dir, '.config.lock')), false);
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
  assert.equal(fs.existsSync(join(dir, '.config.lock')), false);
  withConfigLock(dir, () => {
    assert.throws(() => withConfigLock(dir, () => assert.fail('must not acquire'), { lockTimeoutMs: 25 }), (err) => {
      assert.match(err.message, /Timed out.*configuration lock/);
      assert.ok(err.message.includes(join(dir, '.config.lock')));
      assert.match(err.message, /migrating credentials/);
      return true;
    });
    assert.equal(fs.existsSync(join(dir, '.config.lock')), true);
    assert.equal(fs.statSync(join(dir, '.config.lock')).isFile(), true);
    assert.equal(fs.statSync(join(dir, '.config.lock')).mode & 0o777, 0o600);
    const owner = JSON.parse(fs.readFileSync(join(dir, '.config.lock'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.pidStartTime, processStartTime(process.pid));
    assert.equal(typeof owner.token, 'string');
  });
  assert.equal(fs.existsSync(join(dir, '.config.lock')), false);
});

test('configuration lock upgrades a legacy directory after reclaiming a dead owner without discarding config', (t) => {
  const dir = fixture(t);
  config(dir);
  const lock = join(dir, '.config.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(join(lock, '2147483647-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner', ticket: 1 }));
  const result = migrateConfig(dir, { ...fileOptions, log: () => {}, lockTimeoutMs: 1000 });
  assert.equal(resolvePassword(result, dir), SENTINEL);
  assert.equal(fs.existsSync(lock), false);
});

test('configuration lock preserves live and unrecognized legacy records while upgrading', (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  fs.mkdirSync(lock);
  const name = `${process.pid}-00000000-0000-4000-8000-000000000000.json`;
  const live = JSON.stringify({ pid: process.pid, ticket: 1 });
  fs.writeFileSync(join(lock, name), live);
  assert.throws(() => withConfigLock(dir, () => assert.fail('live owner'), { lockTimeoutMs: 25 }), /Timed out/);
  assert.equal(fs.readFileSync(join(lock, name), 'utf8'), live);
  fs.unlinkSync(join(lock, name));
  fs.writeFileSync(join(lock, 'unrecognized'), 'preserve me');
  assert.throws(() => withConfigLock(dir, () => assert.fail('unknown record'), { lockTimeoutMs: 25 }), (error) => {
    assert.ok(error.message.includes(lock));
    assert.match(error.message, /unrecognized records/);
    assert.match(error.message, /verify none are running/);
    assert.match(error.message, /move only this lock directory aside as a private backup/);
    return true;
  });
  assert.equal(fs.readFileSync(join(lock, 'unrecognized'), 'utf8'), 'preserve me');
});

test('configuration lock reclaims a dead owner and an interrupted empty record', (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  for (const contents of [JSON.stringify({ pid: 2147483647, token: 'dead-owner' }), '']) {
    fs.writeFileSync(lock, contents);
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(lock, past, past);
    let acquired = false;
    withConfigLock(dir, () => { acquired = true; }, { lockTimeoutMs: 1000 });
    assert.equal(acquired, true);
    assert.equal(fs.existsSync(lock), false);
  }
});

test('configuration lock reclaims a live PID whose Linux start time differs', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, pidStartTime: '0', token: 'reused-pid' }));
  withConfigLock(dir, () => assert.notEqual(JSON.parse(fs.readFileSync(lock)).token, 'reused-pid'), { lockTimeoutMs: 1000 });
  assert.equal(fs.existsSync(lock), false);
  fs.mkdirSync(lock);
  fs.writeFileSync(join(lock, `${process.pid}-00000000-0000-4000-8000-000000000000.json`), JSON.stringify({ pid: process.pid, pidStartTime: '0', ticket: 1 }));
  withConfigLock(dir, () => assert.equal(fs.statSync(lock).isFile(), true), { lockTimeoutMs: 1000 });
  assert.equal(fs.existsSync(lock), false);
});

test('configuration lock release preserves a successor with another token', (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  const successor = JSON.stringify({ pid: process.pid, token: 'successor' });
  withConfigLock(dir, () => {
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, successor);
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), successor);
});

test('stale recovery serializes the metadata-check/unlink window against a second reaper', { timeout: 10000 }, async (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const originalUnlink = fs.unlinkSync;
  const program = `
    const fs = require('node:fs');
    const { join } = require('node:path');
    const { withConfigLock } = require(${JSON.stringify(require.resolve('../scripts/_credentials.cjs'))});
    const dir = process.argv[1];
    fs.writeFileSync(join(dir, 'second-started'), 'yes');
    withConfigLock(dir, () => {
      fs.writeFileSync(join(dir, 'second-active'), 'yes');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      fs.unlinkSync(join(dir, 'second-active'));
    });
  `;
  let child, result;
  t.after(() => { fs.unlinkSync = originalUnlink; if (child?.exitCode === null) child.kill('SIGKILL'); });
  fs.unlinkSync = function(target) {
    if (target === lock && !child) {
      // Force a second process to contend after the first reaper's final
      // metadata check, exactly where an unguarded stat/unlink pair races.
      child = spawn(process.execPath, ['-e', program, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      result = childResult(child);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(join(dir, 'second-started')) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
      assert.equal(fs.existsSync(join(dir, 'second-started')), true);
      Atomics.wait(sleeper, 0, 0, 100);
      assert.equal(fs.existsSync(join(dir, 'second-active')), false, 'another reaper must wait for the recovery guard');
    }
    return originalUnlink.apply(fs, arguments);
  };
  try {
    withConfigLock(dir, () => assert.equal(fs.existsSync(join(dir, 'second-active')), false));
  } finally { fs.unlinkSync = originalUnlink; }
  const completed = await result;
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(join(dir, '.config.lock.reclaim')), false);
});

test('a paused creator retries if its empty exclusive-open record was reclaimed', { timeout: 10000 }, async (t) => {
  const dir = fixture(t);
  const lock = join(dir, '.config.lock');
  const guard = join(dir, '.config.lock.reclaim');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const originalOpen = fs.openSync;
  const program = `
    const fs = require('node:fs');
    const { join } = require('node:path');
    const { withConfigLock } = require(${JSON.stringify(require.resolve('../scripts/_credentials.cjs'))});
    const dir = process.argv[1];
    withConfigLock(dir, () => {
      fs.writeFileSync(join(dir, 'second-active'), 'yes');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(join(dir, 'release-second')) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
      if (!fs.existsSync(join(dir, 'release-second'))) throw new Error('creator failed to retry');
      fs.unlinkSync(join(dir, 'second-active'));
    });
  `;
  let child, result;
  t.after(() => { fs.openSync = originalOpen; if (child?.exitCode === null) child.kill('SIGKILL'); });
  fs.openSync = function(target) {
    const fd = originalOpen.apply(fs, arguments);
    if (target === lock && !child) {
      // Pause after O_EXCL succeeds but before owner bytes are published.
      const past = new Date(Date.now() - 5000);
      fs.futimesSync(fd, past, past);
      child = spawn(process.execPath, ['-e', program, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      result = childResult(child);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(join(dir, 'second-active')) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
      assert.equal(fs.existsSync(join(dir, 'second-active')), true, 'second owner must reclaim the empty record');
    } else if (target === guard && child) {
      // The first creator has detected its unlinked inode and now contends
      // with the live replacement. Only this safe retry lets that owner exit.
      fs.writeFileSync(join(dir, 'release-second'), 'yes');
    }
    return fd;
  };
  try {
    withConfigLock(dir, () => assert.equal(fs.existsSync(join(dir, 'second-active')), false, 'must not enter on an unlinked lock inode'));
  } finally { fs.openSync = originalOpen; }
  const completed = await result;
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(guard), false);
});

test('an abandoned recovery guard blocks safely with bounded manual-recovery guidance', (t) => {
  const dir = fixture(t);
  const guard = join(dir, '.config.lock.reclaim');
  const abandoned = JSON.stringify({ pid: 2147483647, token: 'abandoned-reaper' });
  fs.writeFileSync(guard, abandoned);
  for (const staleLock of [false, true]) {
    if (staleLock) fs.writeFileSync(join(dir, '.config.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
    assert.throws(() => withConfigLock(dir, () => assert.fail('must not enter during abandoned recovery'), { lockTimeoutMs: 25 }), (error) => {
      assert.ok(error.message.includes(guard));
      assert.match(error.message, /verify none are running/);
      assert.match(error.message, /remove only this recovery guard/);
      return true;
    });
    assert.equal(fs.readFileSync(guard, 'utf8'), abandoned);
    assert.equal(fs.existsSync(join(dir, '.config.lock')), staleLock, 'a timed-out creator releases only its own lock');
  }
});

test('a live recovery guard produces ordinary contention guidance without manual removal advice', (t) => {
  const dir = fixture(t);
  const guard = join(dir, '.config.lock.reclaim');
  const live = JSON.stringify({ pid: process.pid, pidStartTime: processStartTime(process.pid), token: 'live-reaper' });
  fs.writeFileSync(guard, live);
  for (const existingLock of [false, true]) {
    if (existingLock) fs.writeFileSync(join(dir, '.config.lock'), JSON.stringify({ pid: process.pid, token: 'live-writer' }));
    assert.throws(() => withConfigLock(dir, () => assert.fail('active recovery'), { lockTimeoutMs: 0 }), (error) => {
      assert.match(error.message, /Another process may be migrating credentials/);
      assert.doesNotMatch(error.message, /remove|crashed|\.reclaim/);
      return true;
    });
    assert.equal(fs.readFileSync(guard, 'utf8'), live);
  }
});

test('timeout rereads a vanished guard and reserves manual advice for an unknown owner', (t) => {
  const dir = fixture(t);
  const guard = join(dir, '.config.lock.reclaim');
  fs.writeFileSync(guard, '{}');
  const originalRead = fs.readFileSync;
  t.after(() => { fs.readFileSync = originalRead; });
  fs.readFileSync = function(target) {
    // The last poll saw the guard, but its owner removes it before the
    // deadline diagnostic observes it. This must not recommend cleanup.
    if (target === guard) fs.unlinkSync(guard);
    return originalRead.apply(fs, arguments);
  };
  try {
    assert.throws(() => withConfigLock(dir, () => assert.fail('deadline elapsed'), { lockTimeoutMs: 0 }), (error) => {
      assert.match(error.message, /Another process may be migrating credentials/);
      assert.doesNotMatch(error.message, /remove|crashed|\.reclaim/);
      return true;
    });
  } finally { fs.readFileSync = originalRead; }
  fs.writeFileSync(guard, '{}');
  assert.throws(() => withConfigLock(dir, () => assert.fail('unknown recovery owner'), { lockTimeoutMs: 0 }), /remove only this recovery guard/);
  assert.equal(fs.readFileSync(guard, 'utf8'), '{}');
});

test('recent empty or partial recovery guards get publication grace before manual diagnostics', (t) => {
  const dir = fixture(t);
  const guard = join(dir, '.config.lock.reclaim');
  for (const contents of ['', '{"pid":']) {
    fs.writeFileSync(guard, contents);
    assert.throws(() => withConfigLock(dir, () => assert.fail('recovery publication in progress'), { lockTimeoutMs: 0 }), (error) => {
      assert.match(error.message, /Another process may be migrating credentials/);
      assert.doesNotMatch(error.message, /remove|crashed|\.reclaim/);
      return true;
    });
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(guard, past, past);
    assert.throws(() => withConfigLock(dir, () => assert.fail('abandoned partial recovery record'), { lockTimeoutMs: 0 }), /remove only this recovery guard/);
    assert.equal(fs.readFileSync(guard, 'utf8'), contents);
  }
});

test('an unreadable recovery record reports access trouble without claiming a crashed owner', (t) => {
  const dir = fixture(t);
  const guard = join(dir, '.config.lock.reclaim');
  fs.mkdirSync(guard);
  assert.throws(() => withConfigLock(dir, () => assert.fail('unreadable recovery record'), { lockTimeoutMs: 0 }), (error) => {
    assert.ok(error.message.includes(guard));
    assert.match(error.message, /Unable to read its owner record.*permissions/);
    assert.doesNotMatch(error.message, /crashed|remove only this recovery guard/);
    return true;
  });
  assert.equal(fs.statSync(guard).isDirectory(), true);
});

test('legacy shape validation names private recovery before consulting a native failure marker', (t) => {
  const { createHash } = require('node:crypto');
  const dir = fixture(t);
  for (const agent of [{ keyPassword: SENTINEL }, { keyFile: 'wallet.json', keyPassword: 12 }]) {
    const contents = JSON.stringify({ agent });
    fs.writeFileSync(join(dir, 'config.json'), contents);
    const marker = { version: 1, backend: 'libsecret', fingerprint: createHash('sha256').update(contents).digest('hex'), failedAt: Date.now() };
    fs.writeFileSync(join(dir, '.credential-migration-failure.json'), JSON.stringify(marker));
    for (let i = 0; i < 2; i++) assert.throws(() => migrateConfig(dir, {
      platform: 'linux', env: {}, spawnSync: () => assert.fail('invalid shape must not contact store'),
    }), (error) => {
      assert.ok(error.message.includes(join(dir, 'config.json')));
      assert.match(error.message, /previous config.*private backup/);
      assert.match(error.message, /Repair.*move it aside/);
      assert.doesNotMatch(error.message, /Credential access failed|paused/);
      assert.equal(error.storeAccess, undefined);
      return true;
    });
    assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), contents);
  }
});

test('validation, cross-platform and password mismatch errors never create a migration cooldown', (t) => {
  for (const scenario of ['keyfile', 'password-shape', 'long-password', 'cross-platform', 'mismatch']) {
    const dir = fixture(t);
    const legacy = config(dir);
    const fake = nativeFixture('linux');
    let options = fake.options;
    let expected;
    if (scenario === 'keyfile') { delete legacy.agent.keyFile; expected = /missing a valid agent.keyFile/; }
    if (scenario === 'password-shape') { legacy.agent.keyPassword = 12; expected = /expected a string/; }
    if (scenario === 'long-password') {
      legacy.agent.keyPassword = 'x'.repeat(4000);
      options = { platform: 'darwin', env: {}, spawnSync: () => assert.fail('oversized payload must not contact store') };
      expected = /too long/;
    }
    if (scenario === 'cross-platform' || scenario === 'mismatch') {
      legacy.agent.keyPasswordRef = storePassword(dir, legacy.agent.keyFile, 'other password', fake.options);
      if (scenario === 'cross-platform') {
        options = { platform: 'darwin', env: {}, spawnSync: () => assert.fail('foreign backend must not contact store') };
        expected = /different operating system/;
      } else expected = /does not match its credential reference/;
    }
    const contents = JSON.stringify(legacy);
    fs.writeFileSync(join(dir, 'config.json'), contents);
    for (let i = 0; i < 2; i++) assert.throws(() => migrateConfig(dir, options), (error) => {
      assert.match(error.message, expected);
      assert.equal(error.storeAccess, undefined);
      return true;
    });
    assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false, scenario);
    assert.equal(fs.readFileSync(join(dir, 'config.json'), 'utf8'), contents);
  }
});

test('native migration failures share a secret-free cooldown, expire, and clear on success', (t) => {
  const dir = fixture(t);
  const old = config(dir);
  const before = fs.readFileSync(join(dir, 'config.json'));
  let attempts = 0;
  let now = 100000;
  const options = { platform: 'linux', env: {}, now: () => now, migrationRetryMs: 100,
    spawnSync() { attempts++; return { status: 1, stderr: SENTINEL }; } };
  assert.throws(() => migrateConfig(dir, options), (error) => {
    assert.match(error.message, /Credential access failed \(libsecret\)/);
    assert.equal(error.storeAccess, true);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'storeAccess').enumerable, false);
    return true;
  });
  for (let i = 0; i < 5; i++) assert.throws(() => migrateConfig(dir, options), /retry is paused for 1 second/);
  assert.equal(attempts, 1);
  assert.deepEqual(fs.readFileSync(join(dir, 'config.json')), before);
  assert.equal(fs.readFileSync(old.agent.keyFile, 'utf8'), 'encrypted wallet fixture');
  const markerPath = join(dir, '.credential-migration-failure.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['backend', 'failedAt', 'fingerprint', 'version']);
  assert.deepEqual({ ...marker, fingerprint: undefined }, { version: 1, backend: 'libsecret', failedAt: now, fingerprint: undefined });
  assert.match(marker.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(markerPath, 'utf8').includes(SENTINEL), false);
  now += 100;
  const fake = nativeFixture('linux');
  const migrated = migrateConfig(dir, { ...fake.options, now: () => now, migrationRetryMs: 100, log: () => {} });
  assert.equal(fake.calls.length, 2);
  assert.equal(resolvePassword(migrated, dir, fake.options), SENTINEL);
  assert.equal(fs.existsSync(markerPath), false);
});

test('migration cooldown is invalidated by config bytes or native backend changes and bypassed by file storage', (t) => {
  const dir = fixture(t);
  config(dir);
  let attempts = 0;
  const options = { platform: 'linux', env: {}, spawnSync() { attempts++; return { status: 1, stderr: SENTINEL }; } };
  assert.throws(() => migrateConfig(dir, options), /access failed \(libsecret\)/);
  fs.appendFileSync(join(dir, 'config.json'), '\n');
  assert.throws(() => migrateConfig(dir, options), /access failed \(libsecret\)/);
  assert.equal(attempts, 2, 'changed config must be retried immediately');
  assert.throws(() => migrateConfig(dir, { ...options, platform: 'darwin' }), /access failed \(keychain\)/);
  assert.equal(attempts, 3, 'changed backend must be retried immediately');
  const migrated = migrateConfig(dir, { ...fileOptions, log: () => {} });
  assert.equal(resolvePassword(migrated, dir), SENTINEL);
  assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
});

test('file migration failures never create a retry marker or defer a retry', (t) => {
  const dir = fixture(t);
  config(dir);
  let attempts = 0;
  const options = { ...fileOptions, platform: 'win32', spawnSync() { attempts++; return { status: 1, stderr: SENTINEL }; } };
  for (let i = 0; i < 2; i++) assert.throws(() => migrateConfig(dir, options), /access failed \(file\)/);
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(join(dir, '.credential-migration-failure.json')), false);
});

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stderr = '', stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stderr, stdout }));
  });
}

test('configuration lock serializes repeated concurrent read-modify-write operations', { timeout: 15000 }, async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(join(dir, 'counter'), '0');
  const program = `
    const fs = require('node:fs');
    const { join } = require('node:path');
    const { withConfigLock } = require(${JSON.stringify(require.resolve('../scripts/_credentials.cjs'))});
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const dir = process.argv[1];
    for (let i = 0; i < 40; i++) withConfigLock(dir, () => {
      const target = join(dir, 'counter');
      const count = Number(fs.readFileSync(target, 'utf8'));
      Atomics.wait(wait, 0, 0, 2);
      fs.writeFileSync(target, String(count + 1));
    });
  `;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', program, dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const results = await Promise.all(children.map(childResult));
  assert.ok(results.every(({ status }) => status === 0), JSON.stringify(results));
  assert.equal(Number(fs.readFileSync(join(dir, 'counter'), 'utf8')), 240);
  assert.equal(fs.existsSync(join(dir, '.config.lock')), false);
});

test('six concurrent migrations make one blocking native-store attempt and preserve original config', { timeout: 10000, skip: process.platform === 'win32' }, async (t) => {
  const dir = fixture(t);
  config(dir);
  const before = fs.readFileSync(join(dir, 'config.json'));
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'secret-tool'), `#!${process.execPath}\n
    require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'attempts'))}, 'attempt\\n');
    setTimeout(() => {}, 60000);
  `, { mode: 0o700 });
  const program = `
    const { migrateConfig } = require(${JSON.stringify(require.resolve('../scripts/_credentials.cjs'))});
    const dir = process.argv[1];
    try {
      migrateConfig(dir, { platform: 'linux', env: { ...process.env, PATH: ${JSON.stringify(bin)}, MANIFEST_CREDENTIAL_STORE: 'auto' }, commandTimeoutMs: 500 });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', program, dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const results = await Promise.all(children.map(childResult));
  assert.ok(results.every(({ status, stderr, stdout }) => status === 1 && stdout === '' && /Credential access failed \(libsecret\)/.test(stderr) && !stderr.includes('TEST_ONLY_NATIVE_ERROR_SECRET')), JSON.stringify(results));
  assert.equal(fs.readFileSync(join(dir, 'attempts'), 'utf8'), 'attempt\n');
  assert.deepEqual(fs.readFileSync(join(dir, 'config.json')), before);
  assert.equal(fs.existsSync(join(dir, '.config.lock')), false);
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

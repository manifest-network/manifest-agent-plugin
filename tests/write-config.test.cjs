'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { resolvePassword } = require('../scripts/_credentials.cjs');

function fixture(t) {
  const data = fs.mkdtempSync(join(tmpdir(), 'identity-config-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(join(data, 'chains'));
  fs.mkdirSync(join(data, 'keys'));
  const chains = Object.fromEntries(['testnet', 'mainnet'].map((name) => [name, {
    chainId: `manifest-ledger-${name}`, rpcUrl: 'https://rpc.example.invalid',
    feeTokens: [{ denom: 'umfx', symbol: 'MFX', fixedMinGasPrice: 1 }],
  }]));
  for (const [name, chain] of Object.entries(chains)) {
    fs.writeFileSync(join(data, 'chains', `${name}.json`), JSON.stringify(chain));
  }
  const key = { address: 'manifest1publicfixture', keyfile: join(data, 'keys', 'agent-first.json'),
    password: 'PASSWORD_SECRET "quoted"\nnext line $()' };
  fs.writeFileSync(key.keyfile, 'encrypted-wallet-fixture');
  const path = join(data, 'config.json');
  return { data, chains, key, path, config: () => JSON.parse(fs.readFileSync(path, 'utf8')) };
}

function run(f, script, args, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', script), ...args], {
    input, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, MANIFEST_PLUGIN_DATA: f.data,
      MANIFEST_CREDENTIAL_STORE: 'file', ...extraEnv },
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /PASSWORD_SECRET|OLD_PASSWORD_SECRET/);
  return result;
}

const writeArgs = ['--chain', 'testnet', '--gas-token', 'MFX'];

test('fresh initialization persists a credential reference and only safe stdout', (t) => {
  const f = fixture(t);
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { address: f.key.address, activeChain: 'testnet' });
  assert.equal(f.config().gasPrice, '1umfx');
  assert.equal(Object.hasOwn(f.config().agent, 'keyPassword'), false);
  assert.equal(f.config().agent.keyPasswordRef.backend, 'file');
  assert.equal(resolvePassword(f.config(), f.data), f.key.password);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
});

test('Linux initialization uses libsecret by default without secrets in command arguments', { skip: process.platform !== 'linux' }, (t) => {
  const f = fixture(t);
  const bin = join(f.data, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'secret-tool'), `#!${process.execPath}\n'use strict';
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.env.MANIFEST_PLUGIN_DATA, 'command-args'), JSON.stringify(process.argv) + '\\n');
const entry = path.join(process.env.MANIFEST_PLUGIN_DATA, 'fake-keychain');
if (process.argv[2] === 'store') fs.writeFileSync(entry, fs.readFileSync(0));
else if (process.argv[2] === 'lookup') process.stdout.write(fs.readFileSync(entry));
else process.exit(1);
`, { mode: 0o700 });
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key), {
    PATH: bin, MANIFEST_CREDENTIAL_STORE: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.config().agent.keyPasswordRef.backend, 'libsecret');
  assert.equal(Object.hasOwn(f.config().agent, 'keyPassword'), false);
  assert.doesNotMatch(fs.readFileSync(join(f.data, 'command-args'), 'utf8'), /PASSWORD_SECRET/);
});

test('wallet replacement retains the previous credential and migrates legacy config first', (t) => {
  const f = fixture(t);
  const oldAgent = { keyFile: 'keys/old.json', keyPassword: 'OLD_PASSWORD_SECRET', address: 'manifest1old' };
  fs.writeFileSync(join(f.data, oldAgent.keyFile), 'old-wallet');
  fs.writeFileSync(f.path, JSON.stringify({ activeChain: 'mainnet', gasPrice: '1umfx', chains: f.chains, agent: oldAgent }));
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key));
  assert.equal(result.status, 0, result.stderr);
  const initial = f.config();
  assert.equal(initial.credentialMigration.version, 1);
  assert.equal(resolvePassword(initial, f.data), f.key.password);
  const replacement = { ...f.key, keyfile: join(f.data, 'keys', 'agent-second.json'), password: 'second-fixture' };
  fs.writeFileSync(replacement.keyfile, 'second-wallet');
  assert.equal(run(f, 'write-config.cjs', writeArgs, JSON.stringify(replacement)).status, 0);
  assert.notDeepEqual(initial.agent.keyPasswordRef, f.config().agent.keyPasswordRef);
  assert.equal(resolvePassword(initial, f.data), f.key.password);
  assert.equal(resolvePassword(f.config(), f.data), replacement.password);
  assert.equal(fs.readFileSync(join(f.data, oldAgent.keyFile), 'utf8'), 'old-wallet');
});

test('unavailable store leaves an existing config and wallet unchanged', (t) => {
  const f = fixture(t);
  assert.equal(run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key)).status, 0);
  const before = fs.readFileSync(f.path);
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key), {
    MANIFEST_CREDENTIAL_STORE: 'unsupported',
  });
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readFileSync(f.path), before);
  assert.equal(resolvePassword(f.config(), f.data), f.key.password);
});

test('malformed stdin fails without echoing parser source or creating config', (t) => {
  const f = fixture(t);
  for (const input of ['{"password":"PASSWORD_SECRET", BROKEN', 'null', '[]', '{}']) {
    assert.equal(run(f, 'write-config.cjs', writeArgs, input).status, 1);
    assert.equal(fs.existsSync(f.path), false);
  }
});

test('status is read-only; config updates migrate and preserve the wallet reference', (t) => {
  const f = fixture(t);
  const config = { activeChain: 'testnet', gasPrice: '1umfx', chains: f.chains,
    agent: { keyFile: f.key.keyfile, keyPassword: f.key.password, address: f.key.address } };
  const original = JSON.stringify(config);
  fs.writeFileSync(f.path, original);
  const status = run(f, 'update-config.cjs', ['--status']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(fs.readFileSync(f.path, 'utf8'), original);
  assert.equal(JSON.parse(status.stdout).address, f.key.address);
  const update = run(f, 'update-config.cjs', ['--chain', 'mainnet', '--gas-multiplier', '2']);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(f.config().activeChain, 'mainnet');
  assert.equal(f.config().gasMultiplier, 2);
  assert.equal(resolvePassword(f.config(), f.data), f.key.password);
  assert.equal(Object.hasOwn(f.config().agent, 'keyPassword'), false);
  const ref = f.config().agent.keyPasswordRef;
  assert.equal(run(f, 'update-config.cjs', ['--gas-price', '2umfx', '--refresh-chains']).status, 0);
  assert.deepEqual(f.config().agent.keyPasswordRef, ref);
});

test('malformed legacy config stays secret in status diagnostics', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.path, '{"agent":{"keyPassword":"PASSWORD_SECRET"}, BROKEN');
  assert.equal(run(f, 'update-config.cjs', ['--status']).status, 1);
});

test('configuration validation failures release the lock and preserve the selected wallet', (t) => {
  const f = fixture(t);
  assert.equal(run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key)).status, 0);
  const before = fs.readFileSync(f.path);
  for (const args of [['--gas-multiplier', '0.5'], ['--gas-token', 'UNKNOWN']]) {
    const result = run(f, 'update-config.cjs', args);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false, 'validation must release its owned lock');
    assert.deepEqual(fs.readFileSync(f.path), before);
  }
  fs.rmSync(join(f.data, 'chains'), { recursive: true });
  for (const args of [['--gas-token', 'MFX'], ['--refresh-chains']]) {
    assert.equal(run(f, 'update-config.cjs', args).status, 1);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
    assert.deepEqual(fs.readFileSync(f.path), before);
  }
  assert.equal(resolvePassword(f.config(), f.data), f.key.password);
});

test('status rejects nonobject config with private recovery guidance and no mutation', (t) => {
  const f = fixture(t);
  for (const original of ['null', '[]', 'true', '123', '"OLD_PASSWORD_SECRET"']) {
    fs.writeFileSync(f.path, original, { mode: 0o600 });
    const result = run(f, 'update-config.cjs', ['--status']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(f.path));
    assert.match(result.stderr, /repair/i);
    assert.match(result.stderr, /move.*aside/i);
    assert.equal(fs.readFileSync(f.path, 'utf8'), original);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
  }
});

test('unreadable previous configs get actionable recovery without losing their bytes', (t) => {
  const f = fixture(t);
  for (const original of [
    '{"agent":{"keyPassword":"OLD_PASSWORD_SECRET"}, TRUNCATED',
    'null', '[]',
    JSON.stringify({ agent: { keyFile: f.key.keyfile, keyPassword: 123 } }),
    JSON.stringify({ agent: { keyPassword: 'OLD_PASSWORD_SECRET' } }),
  ]) {
    fs.writeFileSync(f.path, original, { mode: 0o600 });
    const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key));
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(f.path), 'name the previous config path');
    assert.match(result.stderr, /previous|existing/i);
    assert.match(result.stderr, /repair/i);
    assert.match(result.stderr, /move.*aside/i);
    assert.equal(fs.readFileSync(f.path, 'utf8'), original);
    assert.equal(fs.readFileSync(f.key.keyfile, 'utf8'), 'encrypted-wallet-fixture');
    const backup = `${f.path}.invalid-backup`;
    fs.renameSync(f.path, backup);
    const recovery = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key));
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.equal(resolvePassword(f.config(), f.data), f.key.password);
  }
});

test('credential failure identifies retained key material without deleting a live keyfile', (t) => {
  const f = fixture(t);
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key), {
    MANIFEST_CREDENTIAL_STORE: 'unsupported',
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(f.key.keyfile));
  assert.match(result.stderr, /retained|not deleted/i);
  assert.match(result.stderr.split('\n')[0], /MANIFEST_CREDENTIAL_STORE must be/);
  assert.equal(fs.existsSync(f.path), false);
  assert.equal(fs.readFileSync(f.key.keyfile, 'utf8'), 'encrypted-wallet-fixture');
});

test('failures before credential storage report the cause before the retained keyfile', (t) => {
  for (const missingChain of [false, true]) {
    const f = fixture(t);
    if (missingChain) fs.rmSync(join(f.data, 'chains'), { recursive: true });
    const result = run(f, 'write-config.cjs', ['--chain', 'testnet', '--gas-token', 'BOGUS'], JSON.stringify(f.key));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr.split('\n')[0], missingChain ? /Chain data not found/ : /BOGUS/);
    assert.match(result.stderr.split('\n')[1], /Supplied keyfile retained/);
    assert.ok(result.stderr.includes(f.key.keyfile));
    assert.doesNotMatch(result.stderr, /Check the existing config/);
    assert.equal(fs.existsSync(f.path), false);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
    assert.equal(fs.readFileSync(f.key.keyfile, 'utf8'), 'encrypted-wallet-fixture');
  }
});

test('unreadable config retains the safe access diagnostic alongside recovery steps', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.path); // A portable read failure, including when tests run as root.
  const result = run(f, 'write-config.cjs', writeArgs, JSON.stringify(f.key));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const cause = result.stderr.split('\n')[0];
  assert.match(cause, /Unable to read config.json/);
  assert.match(cause, /permissions/);
  assert.match(cause, /repair/i);
  assert.match(cause, /move.*aside/i);
  assert.ok(cause.includes(f.path));
  assert.match(result.stderr.split('\n')[1], /Supplied keyfile retained/);
  assert.equal(fs.statSync(f.path).isDirectory(), true);
  assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
  assert.equal(fs.readFileSync(f.key.keyfile, 'utf8'), 'encrypted-wallet-fixture');
});

test('config edits give private recovery steps for invalid legacy wallet fields', (t) => {
  const f = fixture(t);
  for (const agent of [
    { address: f.key.address, keyPassword: 'OLD_PASSWORD_SECRET' },
    { address: f.key.address, keyFile: f.key.keyfile, keyPassword: 42 },
  ]) {
    const original = JSON.stringify({ activeChain: 'testnet', gasPrice: '1umfx', chains: f.chains, agent });
    fs.writeFileSync(f.path, original);
    assert.equal(run(f, 'update-config.cjs', ['--status']).status, 0);
    const result = run(f, 'update-config.cjs', ['--gas-multiplier', '2']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(f.path));
    assert.match(result.stderr, /previous|existing/i);
    assert.match(result.stderr, /repair/i);
    assert.match(result.stderr, /move.*aside/i);
    assert.equal(fs.readFileSync(f.path, 'utf8'), original);
    assert.equal(fs.existsSync(join(f.data, '.config.lock')), false);
    assert.equal(fs.existsSync(join(f.data, '.credential-migration-failure.json')), false);
  }
});

test('explicit config writes retry a repaired native store immediately after migration failure', { skip: process.platform !== 'linux' }, (t) => {
  for (const script of ['write-config.cjs', 'update-config.cjs']) {
    const f = fixture(t);
    const previous = JSON.stringify({ activeChain: 'testnet', gasPrice: '1umfx', chains: f.chains,
      agent: { keyFile: f.key.keyfile, keyPassword: 'OLD_PASSWORD_SECRET', address: f.key.address } });
    fs.writeFileSync(f.path, previous);
    const bin = join(f.data, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'secret-tool'), `#!${process.execPath}
const fs = require('node:fs');
const { join } = require('node:path');
const dir = process.env.MANIFEST_PLUGIN_DATA;
fs.appendFileSync(join(dir, 'attempts'), process.argv[2] + '\\n');
if (!fs.existsSync(join(dir, 'unlocked'))) process.exit(1);
const entry = join(dir, 'entry-' + process.argv.at(-1));
if (process.argv[2] === 'store') fs.writeFileSync(entry, fs.readFileSync(0));
else process.stdout.write(fs.readFileSync(entry));
`, { mode: 0o700 });
    const env = { PATH: bin, MANIFEST_PLUGIN_DATA: f.data, MANIFEST_CREDENTIAL_STORE: '' };
    const args = script === 'write-config.cjs' ? writeArgs : ['--gas-multiplier', '2'];
    const input = script === 'write-config.cjs' ? JSON.stringify(f.key) : undefined;
    assert.equal(run(f, script, args, input, env).status, 1);
    assert.equal(fs.readFileSync(f.path, 'utf8'), previous);
    assert.equal(fs.existsSync(join(f.data, '.credential-migration-failure.json')), true);
    assert.equal(fs.readFileSync(join(f.data, 'attempts'), 'utf8'), 'store\n');
    fs.writeFileSync(join(f.data, 'unlocked'), 'yes');
    const retry = run(f, script, args, input, env);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fs.existsSync(join(f.data, '.credential-migration-failure.json')), false);
    assert.equal(Object.hasOwn(f.config().agent, 'keyPassword'), false);
    assert.equal(resolvePassword(f.config(), f.data, { env }), script === 'write-config.cjs' ? f.key.password : 'OLD_PASSWORD_SECRET');
  }
});

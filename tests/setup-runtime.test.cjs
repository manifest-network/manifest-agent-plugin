'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
  cpSync, statSync, lstatSync, readlinkSync, symlinkSync, utimesSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn, spawnSync, fork } = require('node:child_process');
const { setupRuntime, acquireLock, LOCK_FILE, processStartTime, parseProcessStartTime } = require('../scripts/setup-runtime.cjs');
const { assertNodeVersion, inspectRuntime, COMPLETION_FILE, RUNTIME_PLATFORM } = require('../scripts/_runtime.cjs');
const hooks = require('../hooks/hooks.json');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'manifest runtime '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, 'immutable plugin');
  const dataDir = join(root, 'persistent data');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(dataDir);
  for (const script of ['setup-runtime.cjs', '_runtime.cjs', '_io.cjs']) {
    cpSync(join(__dirname, '..', 'scripts', script), join(pluginRoot, 'scripts', script));
  }
  function definition(version = '1.0.0') {
    const dependencies = { '@manifest-network/manifest-mcp-node': version };
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'fixture', dependencies }));
    writeFileSync(join(pluginRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'fixture', dependencies },
      'node_modules/@manifest-network/manifest-mcp-node': { version },
      'node_modules/transitive': { version: '2.0.0' },
      'node_modules/platform-only': { version: '1.0.0', optional: true },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
    } }));
  }
  definition();
  async function install(target) {
    rmSync(join(target, 'node_modules'), { recursive: true, force: true });
    const lock = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'));
    for (const [relative, meta] of Object.entries(lock.packages)) {
      if (!relative || meta.optional || meta.dev) continue;
      mkdirSync(join(target, relative, 'dist'), { recursive: true });
      writeFileSync(join(target, relative, 'package.json'), JSON.stringify({ version: meta.version }));
      writeFileSync(join(target, relative, 'dist/index.js'), 'module.exports = {};\n', { mode: 0o755 });
    }
    mkdirSync(join(target, 'node_modules/.bin'));
    for (const server of ['chain', 'lease', 'fred', 'cosmwasm', 'agent']) {
      symlinkSync('../@manifest-network/manifest-mcp-node/dist/index.js', join(target, 'node_modules/.bin', `manifest-mcp-${server}`));
    }
  }
  return { root, pluginRoot, dataDir, definition, install };
}

function assertLockTimeout(error, path) {
  assert.match(error.message, /Timed out waiting/);
  assert.ok(error.message.includes(path), `timeout must identify the exact lock path: ${error.message}`);
  assert.doesNotMatch(error.message, /another runtime setup process/i);
  return true;
}

test('Node guard enforces the full runtime floor before dependency loading', () => {
  for (const version of ['18.20.8', '20.20.0', '22.18.1']) {
    assert.throws(() => assertNodeVersion(version), /Node 22\.19\.0\+ required/);
  }
  for (const version of ['22.19', 'invalid']) assert.throws(() => assertNodeVersion(version), /Unrecognized Node version string/);
  for (const version of ['22.19.0-rc.1', '24.0.0-nightly20250901']) {
    assert.throws(() => assertNodeVersion(version), /Prerelease Node builds are not supported.*stable Node 22\.19\.0\+/);
  }
  for (const version of ['22.19.0', '22.20.1', '24.0.0', '25.1.0']) assert.doesNotThrow(() => assertNodeVersion(version));
});

test('fresh install creates private matching manifests and completion marker; healthy rerun skips install', async (t) => {
  const f = fixture(t);
  let installs = 0;
  const install = async (...args) => { installs++; return f.install(...args); };
  assert.deepEqual(await setupRuntime({ ...f, install }), { installed: true });
  assert.equal(inspectRuntime(f.dataDir, f.pluginRoot).ready, true);
  assert.deepEqual(await setupRuntime({ ...f, install }), { installed: false });
  assert.equal(installs, 1);
  for (const name of ['package.json', 'package-lock.json', COMPLETION_FILE]) {
    assert.equal(statSync(join(f.dataDir, name)).mode & 0o777, 0o600);
  }
  assert.equal(statSync(f.dataDir).mode & 0o777, 0o700);
  assert.equal(existsSync(join(f.dataDir, LOCK_FILE)), false);
  assert.equal(existsSync(join(f.pluginRoot, 'node_modules')), false);
});

test('supported Node majors reuse the same JavaScript runtime, including legacy completion records', async (t) => {
  const f = fixture(t);
  await setupRuntime(f);
  const path = join(f.dataDir, COMPLETION_FILE);
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(marker.runtime, `${process.platform}/${process.arch}`);
  for (const runtime of [RUNTIME_PLATFORM, `${RUNTIME_PLATFORM}/node-22`, `${RUNTIME_PLATFORM}/node-24`]) {
    writeFileSync(path, JSON.stringify({ ...marker, runtime }));
    assert.equal(inspectRuntime(f.dataDir, f.pluginRoot).ready, true);
    assert.deepEqual(await setupRuntime({ ...f, install: async () => { assert.fail('supported Node change must not reinstall'); } }), { installed: false });
  }
  for (const runtime of ['other-platform/other-arch/node-24', `${RUNTIME_PLATFORM}/node-invalid`]) {
    writeFileSync(path, JSON.stringify({ ...marker, runtime }));
    assert.equal(inspectRuntime(f.dataDir, f.pluginRoot).ready, false);
  }
});

test('repairs matching package files with no completion marker and preserves all user records', async (t) => {
  const f = fixture(t);
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(f.pluginRoot, name), join(f.dataDir, name));
  for (const name of ['config.json', 'keys/wallet.json', 'journal/day.jsonl', 'manifests/lease.json', 'manifests-drafts/spec.json']) {
    const path = join(f.dataDir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'USER_RECORD_SENTINEL');
  }
  await setupRuntime(f);
  for (const name of ['config.json', 'keys/wallet.json', 'journal/day.jsonl', 'manifests/lease.json', 'manifests-drafts/spec.json']) {
    assert.equal(readFileSync(join(f.dataDir, name), 'utf8'), 'USER_RECORD_SENTINEL');
  }
});

for (const [label, damage] of [
  ['removed dependency tree', (f) => rmSync(join(f.dataDir, 'node_modules'), { recursive: true })],
  ['removed transitive package', (f) => rmSync(join(f.dataDir, 'node_modules/transitive'), { recursive: true })],
  ['removed dependency file', (f) => rmSync(join(f.dataDir, 'node_modules/transitive/dist/index.js'))],
  ['truncated dependency file', (f) => writeFileSync(join(f.dataDir, 'node_modules/transitive/dist/index.js'), '')],
  ['missing binary', (f) => rmSync(join(f.dataDir, 'node_modules/.bin/manifest-mcp-agent'))],
  ['non-executable binary target', (f) => chmodSync(join(f.dataDir, 'node_modules/@manifest-network/manifest-mcp-node/dist/index.js'), 0o644)],
  ['wrong installed version', (f) => writeFileSync(join(f.dataDir, 'node_modules/transitive/package.json'), '{"version":"0.0.0"}')],
  ['invalid completion record', (f) => writeFileSync(join(f.dataDir, COMPLETION_FILE), '{}')],
  ['runtime platform change', (f) => {
    const path = join(f.dataDir, COMPLETION_FILE);
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    marker.runtime = 'other-platform/other-arch/node-18';
    writeFileSync(path, JSON.stringify(marker));
  }],
]) {
  test(`repairs ${label} even when copied package.json still matches`, async (t) => {
    const f = fixture(t);
    await setupRuntime(f);
    damage(f);
    assert.equal(inspectRuntime(f.dataDir, f.pluginRoot).ready, false);
    assert.deepEqual(await setupRuntime(f), { installed: true });
    assert.equal(inspectRuntime(f.dataDir, f.pluginRoot).ready, true);
  });
}

test('both package changes and lock-only dependency changes trigger repair', async (t) => {
  const f = fixture(t);
  await setupRuntime(f);
  f.definition('1.1.0');
  assert.deepEqual(await setupRuntime(f), { installed: true });
  const lockPath = join(f.pluginRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/transitive'].version = '2.0.1';
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.deepEqual(await setupRuntime(f), { installed: true });
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'node_modules/transitive/package.json'), 'utf8')).version, '2.0.1');
});

test('failed or incomplete install cannot retain a stale success marker and next run repairs it', async (t) => {
  const f = fixture(t);
  await setupRuntime(f);
  f.definition('1.1.0');
  await assert.rejects(setupRuntime({ ...f, install: async () => { throw new Error('install interrupted'); } }), /install interrupted/);
  assert.equal(existsSync(join(f.dataDir, COMPLETION_FILE)), false);
  assert.equal(existsSync(join(f.dataDir, LOCK_FILE)), false);
  await assert.rejects(setupRuntime({ ...f, install: async () => {} }), /differs from lock/);
  assert.equal(existsSync(join(f.dataDir, COMPLETION_FILE)), false);
  assert.deepEqual(await setupRuntime(f), { installed: true });
});

test('concurrent setup callers share one install and wait for its verified completion', async (t) => {
  const f = fixture(t);
  let installs = 0;
  const install = async (...args) => {
    installs++;
    await new Promise((done) => setTimeout(done, 100));
    return f.install(...args);
  };
  const results = await Promise.all([setupRuntime({ ...f, install }), setupRuntime({ ...f, install })]);
  assert.equal(installs, 1);
  assert.deepEqual(results, [{ installed: true }, { installed: false }]);
});

test('dead-process and interrupted empty locks recover; live owner timeout is explicit', async (t) => {
  const f = fixture(t);
  // A terminated child gives a real, no-longer-live PID rather than an
  // assumed PID that could name an unrelated live process on the test host.
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  writeFileSync(join(f.dataDir, LOCK_FILE), JSON.stringify({ pid: child.pid, token: 'dead' }));
  await setupRuntime(f);
  writeFileSync(join(f.dataDir, LOCK_FILE), '');
  utimesSync(join(f.dataDir, LOCK_FILE), new Date(0), new Date(0));
  assert.deepEqual(await setupRuntime(f), { installed: false });
  const release = await acquireLock(f.dataDir);
  await assert.rejects(acquireLock(f.dataDir, { timeoutMs: 20, pollMs: 5 }), /Timed out waiting/);
  release();
});

test('PID reuse is reclaimed only when both recorded process identities have ended', { skip: process.platform !== 'linux' }, async (t) => {
  const f = fixture(t);
  const currentStartTime = processStartTime(process.pid);
  assert.match(currentStartTime, /^\d+$/);
  const wrongStartTime = String(BigInt(currentStartTime) + 1n);
  const path = join(f.dataDir, LOCK_FILE);
  for (const owner of [
    { pid: process.pid, pidStartTime: wrongStartTime },
    { pid: process.pid, pidStartTime: wrongStartTime, childPid: process.pid, childStartTime: wrongStartTime },
  ]) {
    writeFileSync(path, JSON.stringify({ ...owner, token: 'old-incarnation' }));
    const release = await acquireLock(f.dataDir, { timeoutMs: 20, pollMs: 5 });
    const actual = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(actual.pidStartTime, currentStartTime);
    assert.notEqual(actual.token, 'old-incarnation');
    release();
  }
  for (const owner of [
    { pid: process.pid, pidStartTime: currentStartTime, childPid: process.pid, childStartTime: wrongStartTime },
    { pid: process.pid, pidStartTime: wrongStartTime, childPid: process.pid, childStartTime: currentStartTime },
    { pid: process.pid }, // legacy lock: unknown identity must stay conservative
  ]) {
    writeFileSync(path, JSON.stringify({ ...owner, token: 'live-owner' }));
    utimesSync(path, new Date(0), new Date(0));
    await assert.rejects(acquireLock(f.dataDir, { timeoutMs: 20, pollMs: 5 }), /Timed out waiting/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'live-owner');
    rmSync(path);
  }
});

test('process identity reads Linux stat field 22 even when the command contains spaces and parentheses', () => {
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 4)), '123456789', '23', '24'];
  assert.equal(parseProcessStartTime(`123 (node (worker) fixture) ${fields.join(' ')}\n`), '123456789');
  assert.equal(parseProcessStartTime('malformed record'), undefined);
  assert.equal(parseProcessStartTime('123 (node) S 1 2'), undefined);
});

test('lock contention reports its path immediately and returns within the configured bound', async (t) => {
  const f = fixture(t);
  const release = await acquireLock(f.dataDir);
  const diagnostic = [];
  const previous = console.error;
  console.error = (message) => diagnostic.push(message);
  try {
    const pending = acquireLock(f.dataDir, { timeoutMs: 30, pollMs: 5 });
    assert.equal(diagnostic.length, 1, 'emit progress before waiting on the live owner');
    assert.ok(diagnostic[0].includes(join(f.dataDir, LOCK_FILE)));
    await assert.rejects(pending, (error) => assertLockTimeout(error, join(f.dataDir, LOCK_FILE)));
  } finally { console.error = previous; release(); }
});

test('the default lock wait holds a live owner for 60 seconds before reporting timeout', async (t) => {
  const f = fixture(t);
  const release = await acquireLock(f.dataDir);
  const initialOwner = readFileSync(join(f.dataDir, LOCK_FILE), 'utf8');
  let clock = 0;
  let waited = 0;
  const diagnostic = [];
  const previous = console.error;
  console.error = (message) => diagnostic.push(message);
  try {
    await assert.rejects(acquireLock(f.dataDir, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; waited += ms; },
    }), /Timed out waiting/);
    assert.equal(waited, 60000, 'exercise the default deadline without a timeout override');
    assert.equal(clock, 60000);
    assert.equal(diagnostic.length, 1);
    assert.match(diagnostic[0], /waiting to acquire runtime setup lock.*up to 60 seconds/);
    assert.equal(readFileSync(join(f.dataDir, LOCK_FILE), 'utf8'), initialOwner, 'a timed-out waiter must preserve the live owner');
    const sessionHook = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks)
      .find((hook) => hook.command.includes('scripts/session-start.sh'));
    assert.equal(sessionHook.timeout, 90, 'the host must leave time to surface a setup timeout');
    assert.ok(sessionHook.timeout * 1000 > waited, 'SessionStart must outlast the measured default lock wait');
  } finally { console.error = previous; release(); }
});

test('a dangling setup-lock symlink times out while yielding and leaves the symlink untouched', (t) => {
  const f = fixture(t);
  const lock = join(f.dataDir, LOCK_FILE);
  const target = join(f.root, 'absent-lock-target');
  symlinkSync(target, lock);
  const program = `
const { acquireLock } = require(process.argv[1]);
let ticks = 0;
const timer = setInterval(() => ticks++, 2);
const started = performance.now();
(async () => {
  try { const release = await acquireLock(process.argv[2], { timeoutMs: 40, pollMs: 5 }); release(); console.log(JSON.stringify({ acquired: true, ticks })); }
  catch (error) { console.log(JSON.stringify({ error: error.message, ticks, elapsed: performance.now() - started })); }
  finally { clearInterval(timer); }
})();
`;
  // A test-runner timeout cannot interrupt a synchronous loop. Keep this in
  // a separately killable child so the old continue bug fails safely.
  const result = spawnSync(process.execPath, ['-e', program, join(f.pluginRoot, 'scripts/setup-runtime.cjs'), f.dataDir], {
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assertLockTimeout(new Error(outcome.error), lock);
  assert.equal(result.stderr, '', 'an absent owner must not produce a live-owner contention notice');
  assert.ok(outcome.ticks > 0, 'waiting must permit timers and signal handlers to run');
  assert.ok(outcome.elapsed >= 40);
  assert.equal(lstatSync(lock).isSymbolicLink(), true);
  assert.equal(readlinkSync(lock), target);
  assert.equal(existsSync(target), false);
});

test('repeated stale lock replacements share one deadline and yield between attempts', async (t) => {
  const f = fixture(t);
  const lock = join(f.dataDir, LOCK_FILE);
  const replaceStaleOwner = () => writeFileSync(lock, '{"pid":0,"token":"inactive-owner"}');
  replaceStaleOwner();
  let clock = 0;
  let waits = 0;
  await assert.rejects(acquireLock(f.dataDir, {
    timeoutMs: 20, pollMs: 5, now: () => clock,
    sleep: async (ms) => { waits++; clock += ms; replaceStaleOwner(); },
  }), /Timed out waiting/);
  assert.equal(clock, 20, 'reclaiming a stale owner must not reset the deadline');
  assert.equal(waits, 4, 'each unsuccessful attempt must yield before retrying');
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":0,"token":"inactive-owner"}', 'the expired waiter must leave the last owner untouched');
});

test('successful stale-owner reclamation is silent and still yields before retrying', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dataDir, LOCK_FILE), '{"pid":0,"token":"inactive-owner"}');
  const diagnostic = [];
  const previous = console.error;
  console.error = (message) => diagnostic.push(message);
  let clock = 0;
  let waits = 0;
  try {
    const release = await acquireLock(f.dataDir, {
      now: () => clock, sleep: async (ms) => { clock += ms; waits++; },
    });
    release();
    assert.equal(waits, 1, 'reclaim must yield even when no live owner was observed');
    assert.deepEqual(diagnostic, []);
  } finally { console.error = previous; }
});

test('a deadline reached during stale-owner inspection does not unlink the owner', async (t) => {
  const f = fixture(t);
  const path = join(f.dataDir, LOCK_FILE);
  const contents = '{"pid":0,"token":"expired-stale-owner"}';
  writeFileSync(path, contents);
  let clock = 0;
  await assert.rejects(acquireLock(f.dataDir, {
    timeoutMs: 2, now: () => clock++,
    sleep: async () => assert.fail('an expired attempt must stop before another sleep'),
  }), (error) => assertLockTimeout(error, path));
  assert.equal(readFileSync(path, 'utf8'), contents);
});

test('a directory at the lock path fails promptly with its filesystem error', async (t) => {
  const f = fixture(t);
  const path = join(f.dataDir, LOCK_FILE);
  mkdirSync(path);
  await assert.rejects(acquireLock(f.dataDir, {
    sleep: async () => assert.fail('a non-readable lock must fail instead of waiting'),
  }), (error) => {
    assert.equal(error.code, 'EISDIR');
    return true;
  });
  assert.equal(statSync(path).isDirectory(), true);
});

test('reclaiming a stale lock symlink preserves the referenced file', async (t) => {
  const f = fixture(t);
  const target = join(f.root, 'external-owner.json');
  const contents = '{"pid":0,"token":"inactive-external-record"}';
  writeFileSync(target, contents);
  symlinkSync(target, join(f.dataDir, LOCK_FILE));
  const release = await acquireLock(f.dataDir, { timeoutMs: 100, pollMs: 5 });
  try {
    assert.equal(lstatSync(join(f.dataDir, LOCK_FILE)).isFile(), true);
    assert.equal(readFileSync(target, 'utf8'), contents);
  } finally { release(); }
  assert.equal(readFileSync(target, 'utf8'), contents);
});

test('rejects plugin-root and symlinked child data paths before modifying the plugin', async (t) => {
  const f = fixture(t);
  await assert.rejects(setupRuntime({ ...f, dataDir: f.pluginRoot }), /outside the installed plugin/);
  await assert.rejects(setupRuntime({ ...f, dataDir: join(f.pluginRoot, 'not-created') }), /outside the installed plugin/);
  assert.equal(existsSync(join(f.pluginRoot, 'not-created')), false);
  const link = join(f.root, 'plugin-link');
  symlinkSync(f.pluginRoot, link);
  await assert.rejects(setupRuntime({ ...f, dataDir: join(link, 'not-created') }), /outside the installed plugin/);
  assert.equal(existsSync(join(f.pluginRoot, 'not-created')), false);
});

test('missing data or tracked lock fails clearly without creating a completion record', async (t) => {
  const f = fixture(t);
  await assert.rejects(setupRuntime({ pluginRoot: f.pluginRoot }), /MANIFEST_PLUGIN_DATA is not set/);
  rmSync(join(f.pluginRoot, 'package-lock.json'));
  await assert.rejects(setupRuntime(f), /package-lock\.json/);
  assert.equal(existsSync(join(f.dataDir, COMPLETION_FILE)), false);
});

function startCli(f, env = {}, args = []) {
  const child = spawn(process.execPath, [join(f.pluginRoot, 'scripts/setup-runtime.cjs'), ...args], {
    env: { ...process.env, MANIFEST_PLUGIN_DATA: f.dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise((done) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
  return { child, completion };
}

function cli(...args) { return startCli(...args).completion; }

test('data directory chmod tolerates supported filesystem errors but propagates unexpected failures', async (t) => {
  const f = fixture(t);
  await setupRuntime(f);
  const preload = join(f.root, 'chmod-filesystem.cjs');
  writeFileSync(preload, `
const fs = require('node:fs');
const original = fs.chmodSync;
fs.chmodSync = (path, mode) => {
  if (path === process.env.MANIFEST_PLUGIN_DATA) {
    const error = new Error('fixture chmod ' + process.env.MANIFEST_CHMOD_ERROR);
    error.code = process.env.MANIFEST_CHMOD_ERROR;
    throw error;
  }
  return original(path, mode);
};
`);
  for (const code of ['EPERM', 'EACCES', 'EROFS', 'ENOSYS', 'ENOENT']) {
    const result = await cli(f, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, MANIFEST_CHMOD_ERROR: code });
    assert.equal(result.status, 0, `${code}: ${result.stderr}`);
    assert.match(result.stderr, /runtime dependencies ready/);
  }
  const invalid = await cli(f, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, MANIFEST_CHMOD_ERROR: 'EINVAL' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /fixture chmod EINVAL/);
});

test('CLI successfully installs through npm and a second process skips npm', async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'npm shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'npm'), `#!${process.execPath}
const { rmSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const install = ${f.install.toString()};
appendFileSync(join(process.cwd(), 'npm-invocations'), 'called\\n');
install(process.cwd()).catch(() => { process.exitCode = 1; });
`, { mode: 0o700 });
  const first = await cli(f, { PATH: shim });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.match(first.stderr, /installed and verified/);
  const second = await cli(f, { PATH: shim });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /runtime dependencies ready/);
  assert.equal(readFileSync(join(f.dataDir, 'npm-invocations'), 'utf8'), 'called\n');
  assert.equal(existsSync(join(f.dataDir, '.last-install.log')), false);
});

test('retry after SIGKILL waits for the surviving installer before starting another npm', { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'npm shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'npm'), `#!${process.execPath}
const { rmSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const install = ${f.install.toString()};
const active = join(process.cwd(), 'active-npm');
if (existsSync(active)) writeFileSync(join(process.cwd(), 'OVERLAP'), 'yes');
writeFileSync(active, String(process.pid));
appendFileSync(join(process.cwd(), 'npm-pids'), process.pid + '\\n');
const timer = setInterval(async () => {
  if (!existsSync(join(process.cwd(), 'allow-npm-finish'))) return;
  clearInterval(timer);
  try { await install(process.cwd()); } finally { rmSync(active, { force: true }); }
}, 20);
`, { mode: 0o700 });
  const children = [];
  const cleanupPids = [];
  const waitFor = async (predicate) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 5000) throw new Error('Timed out waiting for installer fixture.');
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  try {
    const first = startCli(f, { PATH: shim });
    children.push(first.child);
    await waitFor(() => existsSync(join(f.dataDir, 'npm-pids')));
    const owner = JSON.parse(readFileSync(join(f.dataDir, LOCK_FILE), 'utf8'));
    if (process.platform === 'linux') {
      assert.match(owner.pidStartTime, /^\d+$/);
      assert.match(owner.childStartTime, /^\d+$/);
    }
    cleanupPids.push(owner.childPid, Number(readFileSync(join(f.dataDir, 'active-npm'), 'utf8')));
    assert.notEqual(owner.childPid, first.child.pid, 'the worker owns the active install independently');
    first.child.kill('SIGKILL');
    await first.completion;
    const second = startCli(f, { PATH: shim });
    children.push(second.child);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(readFileSync(join(f.dataDir, 'npm-pids'), 'utf8').trim().split('\n').length, 1);
    assert.equal(existsSync(join(f.dataDir, 'OVERLAP')), false);
    writeFileSync(join(f.dataDir, 'allow-npm-finish'), 'yes');
    await waitFor(() => inspectRuntime(f.dataDir, f.pluginRoot).ready);
    const result = await second.completion;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.dataDir, 'OVERLAP')), false);
    assert.equal(readFileSync(join(f.dataDir, 'npm-pids'), 'utf8').trim().split('\n').length, 2);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    for (const pid of cleanupPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
  }
});

test('installer worker disconnected before the start handshake exits without running npm', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const worker = fork(join(f.pluginRoot, 'scripts/setup-runtime.cjs'), ['--install-worker'], {
    cwd: f.dataDir, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => worker.kill('SIGKILL'));
  const exited = new Promise((done) => worker.once('exit', (code) => done(code)));
  worker.disconnect();
  assert.equal(await exited, 1);
  assert.equal(existsSync(join(f.dataDir, 'node_modules')), false);
  assert.equal(existsSync(join(f.dataDir, '.last-install.log')), false);
});

test('CLI invokes locked npm ci and keeps npm output in a private failure log', async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'npm shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "INSTALL_LOG_SENTINEL\\n"\nexit 17\n', { mode: 0o700 });
  const result = await cli(f, { PATH: shim });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /npm ci failed \(exit 17\)/);
  assert.doesNotMatch(result.stderr, /INSTALL_LOG_SENTINEL/);
  const log = readFileSync(join(f.dataDir, '.last-install.log'), 'utf8');
  assert.match(log, /^ci\n--omit=dev\n--ignore-scripts\n--no-audit\n--no-fund\n/);
  assert.match(log, /INSTALL_LOG_SENTINEL/);
  assert.equal(statSync(join(f.dataDir, '.last-install.log')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.dataDir, COMPLETION_FILE)), false);
  assert.equal(existsSync(join(f.dataDir, LOCK_FILE)), false);
});

for (const [name, script, mode, expected] of [
  ['npm lacks execute permission', '#!/bin/sh\nexit 17\n', 0o600, /Could not run npm ci:.*EACCES/],
  ['npm exits silently', '#!/bin/sh\nexit 17\n', 0o700, /npm ci failed \(exit 17\)/],
  ['npm receives a signal without output', '#!/bin/sh\nkill -TERM "$$"\n', 0o700, /npm ci failed \(SIGTERM\)/],
  ['npm silently leaves an incomplete install', '#!/bin/sh\nexit 0\n', 0o700, /Missing or invalid installed dependency/],
]) {
  test(`CLI removes the empty log and avoids a missing-log diagnostic when ${name}`, async (t) => {
    const f = fixture(t);
    const shim = join(f.root, 'npm shim');
    mkdirSync(shim);
    writeFileSync(join(shim, 'npm'), script, { mode });
    const result = await cli(f, { PATH: shim });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /\.last-install\.log/);
    assert.equal(existsSync(join(f.dataDir, '.last-install.log')), false);
    assert.equal(existsSync(join(f.dataDir, COMPLETION_FILE)), false);
    assert.equal(existsSync(join(f.dataDir, LOCK_FILE)), false);
  });
}

test('CLI preserves and references nonempty npm output after signal termination', async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'npm shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'npm'), '#!/bin/sh\nprintf "BEFORE_SIGNAL_SENTINEL\\n"\nkill -TERM "$$"\n', { mode: 0o700 });
  const result = await cli(f, { PATH: shim });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci failed \(SIGTERM\)/);
  assert.ok(result.stderr.includes(join(f.dataDir, '.last-install.log')));
  assert.doesNotMatch(result.stderr, /BEFORE_SIGNAL_SENTINEL/);
  assert.equal(readFileSync(join(f.dataDir, '.last-install.log'), 'utf8'), 'BEFORE_SIGNAL_SENTINEL\n');
});

test('CLI reports missing npm, unsupported arguments and unsupported Node without succeeding', async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'empty path');
  mkdirSync(shim);
  const missing = await cli(f, { PATH: shim });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm was not found on PATH\. Install npm/);
  assert.doesNotMatch(missing.stderr, /See .*\.last-install\.log/);
  assert.equal(existsSync(join(f.dataDir, '.last-install.log')), false);
  const args = await cli(f, {}, ['--force']);
  assert.equal(args.status, 1);
  assert.match(args.stderr, /Usage:/);
  const preload = join(f.root, 'old-node.cjs');
  writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.18.0" });\n');
  const old = await cli(f, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /Node 22\.19\.0\+ required \(found 22\.18\.0\)/);
});

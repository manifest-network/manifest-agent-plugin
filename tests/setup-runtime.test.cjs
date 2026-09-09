'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
  cpSync, statSync, symlinkSync, utimesSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn, spawnSync, fork } = require('node:child_process');
const { setupRuntime, acquireLock, LOCK_FILE } = require('../scripts/setup-runtime.cjs');
const { assertNodeVersion, inspectRuntime, COMPLETION_FILE } = require('../scripts/_runtime.cjs');

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

test('Node guard enforces the full runtime floor before dependency loading', () => {
  for (const version of ['18.20.8', '20.20.0', '22.18.1', '22.19', 'invalid']) {
    assert.throws(() => assertNodeVersion(version), /Node 22\.19\.0\+ required/);
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

test('CLI reports missing npm, unsupported arguments and unsupported Node without succeeding', async (t) => {
  const f = fixture(t);
  const shim = join(f.root, 'empty path');
  mkdirSync(shim);
  const missing = await cli(f, { PATH: shim });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not run npm ci/);
  const args = await cli(f, {}, ['--force']);
  assert.equal(args.status, 1);
  assert.match(args.stderr, /Usage:/);
  const preload = join(f.root, 'old-node.cjs');
  writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.18.0" });\n');
  const old = await cli(f, { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /Node 22\.19\.0\+ required \(found 22\.18\.0\)/);
});

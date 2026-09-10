'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { waitForRuntime, LOCK_FILE, COMPLETION_FILE, RUNTIME_PLATFORM, readRuntimeDefinition,
  snapshotDependencies, inspectRuntime, readSetupLock, processStartTime } = require('../scripts/_runtime.cjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-wait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, 'plugin');
  const data = join(root, 'data');
  mkdirSync(plugin);
  mkdirSync(join(data, 'node_modules/dep'), { recursive: true });
  const pkg = JSON.stringify({ dependencies: { dep: '1.0.0' } });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies: { dep: '1.0.0' } }, 'node_modules/dep': { version: '1.0.0' },
  } });
  for (const dir of [plugin, data]) {
    writeFileSync(join(dir, 'package.json'), pkg);
    writeFileSync(join(dir, 'package-lock.json'), lock);
  }
  writeFileSync(join(data, 'node_modules/dep/package.json'), '{"version":"1.0.0"}');
  const lockPath = join(data, LOCK_FILE);
  const stamp = () => writeFileSync(join(data, COMPLETION_FILE), JSON.stringify({
    schema: 1, fingerprint: readRuntimeDefinition(plugin).fingerprint,
    runtime: RUNTIME_PLATFORM, files: snapshotDependencies(data),
  }));
  return { data, plugin, stamp, lockPath };
}

function timing(onTick = () => {}) {
  let clock = 0;
  let notifications = 0;
  return {
    options: { graceMs: 20, timeoutMs: 80, pollMs: 10, now: () => clock,
      sleep: async (ms) => { clock += ms; onTick(clock); }, onWaiting: () => { notifications++; } },
    elapsed: () => clock, notifications: () => notifications,
  };
}

test('ready runtime starts immediately with no startup message', async (t) => {
  const f = fixture(t); f.stamp(); const timer = timing();
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 0); assert.equal(timer.notifications(), 0);
});

test('waits for a delayed setup lock and verified completion after the initial grace', async (t) => {
  const f = fixture(t);
  const timer = timing((ms) => {
    if (ms === 10) writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
    if (ms === 40) { f.stamp(); rmSync(f.lockPath); }
  });
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 40); assert.equal(timer.notifications(), 1);
});

test('accepts setup completion between polls without needing to observe the lock', async (t) => {
  const f = fixture(t); const timer = timing(() => f.stamp());
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 10);
});

test('a completion record does not start the server while an installer holds its lock', async (t) => {
  const f = fixture(t); f.stamp(); writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
  const timer = timing((ms) => { if (ms === 30) rmSync(f.lockPath); });
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 30);
});

test('failed setup releases its lock and reports the dependency failure promptly', async (t) => {
  const f = fixture(t); writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
  const timer = timing(() => rmSync(f.lockPath));
  const result = await waitForRuntime(f.data, f.plugin, timer.options);
  assert.equal(result.ready, false); assert.match(result.reason, /runtime-install/);
  assert.equal(timer.elapsed(), 10);
});

test('no setup ever starts: stop after the grace without writing runtime files', async (t) => {
  const f = fixture(t); const timer = timing();
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, false);
  assert.equal(timer.elapsed(), 20); assert.equal(existsSync(f.lockPath), false);
  assert.equal(existsSync(join(f.data, COMPLETION_FILE)), false);
});

test('a stuck or changing lock cannot extend the deadline or be deleted by the launcher', async (t) => {
  const f = fixture(t); writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
  const timer = timing((ms) => writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid, token: ms })));
  const result = await waitForRuntime(f.data, f.plugin, timer.options);
  assert.equal(result.ready, false); assert.match(result.reason, /Timed out.*runtime-setup/);
  assert.equal(timer.elapsed(), 80); assert.equal(existsSync(f.lockPath), true);
});


test('default startup grace allows setup to begin near two seconds', async (t) => {
  const f = fixture(t);
  const timer = timing((ms) => {
    if (ms === 1800) writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
    if (ms === 2300) { f.stamp(); rmSync(f.lockPath); }
  });
  const { graceMs, timeoutMs, pollMs, ...clock } = timer.options;
  assert.equal((await waitForRuntime(f.data, f.plugin, clock)).ready, true);
  assert.equal(timer.elapsed(), 2300);
});

test('default no-setup grace expires at two seconds and the installer deadline at 25 seconds', async (t) => {
  const f = fixture(t);
  for (const [active, expected] of [[false, 2000], [true, 25000]]) {
    if (active) writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid }));
    const timer = timing();
    const { graceMs, timeoutMs, pollMs, ...clock } = timer.options;
    const result = await waitForRuntime(f.data, f.plugin, clock);
    assert.equal(result.ready, false);
    assert.equal(timer.elapsed(), expected);
    if (active) assert.match(result.reason, /Timed out/);
  }
});

test('dead owner lock never blocks a ready runtime and remains untouched by the launcher', async (t) => {
  const f = fixture(t); f.stamp();
  const ended = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(ended.status, 0);
  writeFileSync(f.lockPath, JSON.stringify({ pid: ended.pid }));
  const timer = timing();
  assert.equal(readSetupLock(f.data).active, false);
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 0); assert.equal(timer.notifications(), 0);
  assert.equal(existsSync(f.lockPath), true);
  rmSync(join(f.data, COMPLETION_FILE));
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, false);
  assert.equal(timer.elapsed(), 20, 'an incomplete runtime gets only startup grace, not a dead-owner wait');
});

test('launcher uses parent and worker identities, including reused PIDs', { skip: process.platform !== 'linux' }, async (t) => {
  const f = fixture(t); f.stamp();
  const started = processStartTime(process.pid);
  assert.match(started, /^\d+$/);
  const reused = String(BigInt(started) + 1n);
  for (const owner of [
    { pid: process.pid, pidStartTime: started },
    { pid: process.pid, pidStartTime: reused, childPid: process.pid, childStartTime: started },
  ]) {
    writeFileSync(f.lockPath, JSON.stringify(owner));
    const timer = timing((ms) => { if (ms === 30) rmSync(f.lockPath); });
    assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
    assert.equal(timer.elapsed(), 30);
  }
  writeFileSync(f.lockPath, JSON.stringify({ pid: process.pid, pidStartTime: reused }));
  const timer = timing();
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 0); assert.equal(existsSync(f.lockPath), true);
});

test('partial lock creation is briefly active; stale empty or ownerless locks do not block ready runtime', async (t) => {
  const f = fixture(t); f.stamp();
  writeFileSync(f.lockPath, '');
  const observed = readSetupLock(f.data);
  assert.equal(observed.active, true);
  assert.equal(readSetupLock(f.data, { now: () => observed.stat.mtimeMs + 1001 }).active, false);
  utimesSync(f.lockPath, new Date(0), new Date(0));
  assert.equal((await waitForRuntime(f.data, f.plugin)).ready, true);
  writeFileSync(f.lockPath, '{}');
  assert.equal((await waitForRuntime(f.data, f.plugin)).ready, true);
  assert.equal(existsSync(f.lockPath), true);
});

test('completion metadata failures report distinct actionable causes', (t) => {
  const f = fixture(t); f.stamp();
  const path = join(f.data, COMPLETION_FILE);
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  for (const [changed, expected] of [
    [{ schema: 99 }, /unsupported schema/],
    [{ fingerprint: 'old-lock' }, /fingerprint.*package\/lock/],
    [{ runtime: 'foreign/platform' }, /different or invalid platform/],
    [{ files: [] }, /no valid dependency file inventory/],
    [{ files: {} }, /no valid dependency file inventory/],
  ]) {
    writeFileSync(path, JSON.stringify({ ...baseline, ...changed }));
    const result = inspectRuntime(f.data, f.plugin);
    assert.equal(result.ready, false); assert.match(result.reason, expected);
  }
  writeFileSync(path, 'null');
  assert.match(inspectRuntime(f.data, f.plugin).reason, /must be a JSON object/);
});

test('native addons cannot be stamped or accepted as a runtime shared across Node majors', (t) => {
  const f = fixture(t); f.stamp();
  const addon = join(f.data, 'node_modules/dep/addon.node');
  writeFileSync(addon, 'not a real native binary');
  assert.throws(() => snapshotDependencies(f.data), /Native addon requires Node-specific runtime support/);
  const path = join(f.data, COMPLETION_FILE);
  const completion = JSON.parse(readFileSync(path, 'utf8'));
  completion.files.push(['node_modules/dep/addon.node', 'file', 23]);
  writeFileSync(path, JSON.stringify(completion));
  assert.match(inspectRuntime(f.data, f.plugin).reason, /Native addon requires Node-specific runtime support/);
});

test('a .node suffix on package directories or symlinks does not imply a native addon', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.data, 'node_modules/javascript.node'));
  writeFileSync(join(f.data, 'node_modules/javascript.node/index.cjs'), 'module.exports = 42;');
  symlinkSync('package.json', join(f.data, 'node_modules/dep/alias.node'));
  symlinkSync('../javascript.node', join(f.data, 'node_modules/dep/directory.node'));
  f.stamp();
  const completion = JSON.parse(readFileSync(join(f.data, COMPLETION_FILE), 'utf8'));
  assert.ok(completion.files.some(([path, type]) => path === 'node_modules/javascript.node/index.cjs' && type === 'file'));
  assert.ok(completion.files.some(([path, type]) => path === 'node_modules/dep/alias.node' && type === 'link'));
  assert.equal(inspectRuntime(f.data, f.plugin).ready, true);
  // A directory suffix must neither abort traversal nor hide an actual addon.
  writeFileSync(join(f.data, 'node_modules/javascript.node/addon.node'), 'native fixture');
  assert.throws(() => snapshotDependencies(f.data), /Native addon requires Node-specific runtime support/);
});

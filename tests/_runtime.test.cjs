'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { waitForRuntime, LOCK_FILE, COMPLETION_FILE, RUNTIME_PLATFORM, readRuntimeDefinition,
  snapshotDependencies } = require('../scripts/_runtime.cjs');

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
    if (ms === 10) writeFileSync(f.lockPath, '{}');
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
  const f = fixture(t); f.stamp(); writeFileSync(f.lockPath, '{}');
  const timer = timing((ms) => { if (ms === 30) rmSync(f.lockPath); });
  assert.equal((await waitForRuntime(f.data, f.plugin, timer.options)).ready, true);
  assert.equal(timer.elapsed(), 30);
});

test('failed setup releases its lock and reports the dependency failure promptly', async (t) => {
  const f = fixture(t); writeFileSync(f.lockPath, '{}');
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
  const f = fixture(t); writeFileSync(f.lockPath, '{}');
  const timer = timing((ms) => writeFileSync(f.lockPath, JSON.stringify({ token: ms })));
  const result = await waitForRuntime(f.data, f.plugin, timer.options);
  assert.equal(result.ready, false); assert.match(result.reason, /Timed out.*runtime-setup/);
  assert.equal(timer.elapsed(), 80); assert.equal(existsSync(f.lockPath), true);
});

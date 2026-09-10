'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { checkLeaseStateParity } = require('../ci/lease-state-parity.cjs');

// A small generated-enum fixture exercises parity without importing an SDK.
const SDK_ENUM = {
  2: 'LEASE_STATE_ACTIVE',
  3: 'LEASE_STATE_CLOSED',
  '-1': 'UNRECOGNIZED',
  LEASE_STATE_ACTIVE: 2,
  LEASE_STATE_CLOSED: 3,
  UNRECOGNIZED: -1,
};
const STATES = { 2: 'LEASE_STATE_ACTIVE', 3: 'LEASE_STATE_CLOSED' };
const CLI = join(__dirname, '..', 'ci', 'lease-state-parity.cjs');

test('parity accepts matching states while excluding reverse enum entries and the SDK sentinel', () => {
  assert.equal(checkLeaseStateParity(SDK_ENUM, STATES), 2);
});

test('parity rejects the original CLOSED to INSUFFICIENT_FUNDS mis-mapping', () => {
  assert.throws(() => checkLeaseStateParity(SDK_ENUM, {
    ...STATES, 3: 'LEASE_STATE_INSUFFICIENT_FUNDS',
  }), /Plugin STATES differs/);
});

test('parity rejects a newly added SDK state missing from the plugin', () => {
  assert.throws(() => checkLeaseStateParity({
    ...SDK_ENUM, 5: 'LEASE_STATE_EXPIRED', LEASE_STATE_EXPIRED: 5,
  }, STATES), /Plugin STATES differs/);
});

test('parity rejects a plugin state absent from the SDK', () => {
  assert.throws(() => checkLeaseStateParity(SDK_ENUM, {
    ...STATES, 5: 'LEASE_STATE_EXPIRED',
  }), /Plugin STATES differs/);
});

test('parity rejects an empty SDK enum even when the plugin table is empty', () => {
  for (const sdk of [{}, { '-1': 'UNRECOGNIZED', UNRECOGNIZED: -1 }]) {
    assert.throws(() => checkLeaseStateParity(sdk, {}), /contains no numeric chain states/);
  }
});

test('parity CLI requires an explicit runtime data directory', () => {
  for (const args of [[], ['--data-dir'], ['--unknown', '/tmp'], ['--data-dir', '--json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: node ci\/lease-state-parity.cjs --data-dir/);
  }
});

test('parity CLI fails if the specified runtime has no SDK', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lease-state-parity-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Cannot find module/);
  assert.ok(result.stderr.includes(dataDir));
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

const CHAIN_STATES = [
  ['0', 'LEASE_STATE_UNSPECIFIED', false],
  ['1', 'LEASE_STATE_PENDING', false],
  ['2', 'LEASE_STATE_ACTIVE', false],
  ['3', 'LEASE_STATE_CLOSED', true],
  ['4', 'LEASE_STATE_REJECTED', true],
  ['5', 'LEASE_STATE_EXPIRED', true],
];

for (const [value, name, terminal] of CHAIN_STATES) {
  test(`CLI reports ${name} and its terminal flag for numeric and named input`, () => {
    for (const state of [value, name]) {
      const result = runScript('decode-lease-state.cjs', ['--state', state, '--json']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(result.json, { name, terminal });
    }
  });
}

test('CLI retains terminal classification for the legacy INSUFFICIENT_FUNDS name', () => {
  const name = 'LEASE_STATE_INSUFFICIENT_FUNDS';
  const result = runScript('decode-lease-state.cjs', ['--state', name, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json, { name, terminal: true });
});

test('CLI prints the canonical name without --json', () => {
  const result = runScript('decode-lease-state.cjs', ['--state', '5']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'LEASE_STATE_EXPIRED\n');
  assert.equal(result.stderr, '');
});

test('CLI reports UNKNOWN as non-terminal for unrecognized states', () => {
  for (const state of ['6', '99', '-1', 'invalid']) {
    const result = runScript('decode-lease-state.cjs', ['--state', state, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { name: 'UNKNOWN', terminal: false });
  }
});

test('CLI prints UNKNOWN without --json for an unrecognized state', () => {
  const result = runScript('decode-lease-state.cjs', ['--state', '6']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'UNKNOWN\n');
});

test('CLI rejects a missing --state value', () => {
  for (const args of [[], ['--json'], ['--state']]) {
    const result = runScript('decode-lease-state.cjs', args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Missing required flag: --state\n');
  }
});

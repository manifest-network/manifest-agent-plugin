'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decode, isTerminal, STATES } = require('../scripts/_lease-state.cjs');

// Expected wire values from the Manifest billing v1 LeaseState proto.
const CHAIN_STATES = [
  [0, 'LEASE_STATE_UNSPECIFIED', false],
  [1, 'LEASE_STATE_PENDING', false],
  [2, 'LEASE_STATE_ACTIVE', false],
  [3, 'LEASE_STATE_CLOSED', true],
  [4, 'LEASE_STATE_REJECTED', true],
  [5, 'LEASE_STATE_EXPIRED', true],
];

for (const [value, name, terminal] of CHAIN_STATES) {
  test(`decode() and isTerminal() handle every encoding of ${name}`, () => {
    for (const input of [value, String(value), name]) {
      const decoded = decode(input);
      assert.equal(decoded, name, `input: ${JSON.stringify(input)}`);
      assert.equal(isTerminal(decoded), terminal);
    }
  });
}

test('decode() returns undefined for unknown integer', () => {
  for (const input of [6, '6', 99, -1]) {
    assert.equal(decode(input), undefined);
    assert.equal(isTerminal(decode(input)), false);
  }
});

test('decode() returns undefined for non-canonical strings', () => {
  assert.equal(decode('ACTIVE'), undefined);
  assert.equal(decode('lease_state_active'), undefined);
  // Note on the empty-string quirk: Number('') === 0 and `0 in STATES`, so
  // decode('') returns 'LEASE_STATE_UNSPECIFIED'. This is a documented edge
  // case; the chain never emits empty strings for state, so it's not load-
  // bearing in practice.
  assert.equal(decode(''), 'LEASE_STATE_UNSPECIFIED');
});

test('INSUFFICIENT_FUNDS string remains terminal for agent-core compatibility without a numeric mapping', () => {
  const name = 'LEASE_STATE_INSUFFICIENT_FUNDS';
  assert.equal(decode(name), name);
  assert.equal(isTerminal(decode(name)), true);
  assert.equal(Object.values(STATES).includes(name), false);
});

test('unknown canonical strings pass through without being classified as terminal', () => {
  assert.equal(decode('LEASE_STATE_FUTURE'), 'LEASE_STATE_FUTURE');
  assert.equal(isTerminal(decode('LEASE_STATE_FUTURE')), false);
  assert.equal(isTerminal('UNKNOWN'), false);
});

test('STATES table covers the full enum range', () => {
  assert.deepEqual(Object.keys(STATES).map(Number).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

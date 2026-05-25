'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decode, isTerminal, STATES } = require('../scripts/_lease-state.cjs');

test('decode() round-trips integer to canonical name', () => {
  assert.equal(decode(0), 'LEASE_STATE_UNSPECIFIED');
  assert.equal(decode(1), 'LEASE_STATE_PENDING');
  assert.equal(decode(2), 'LEASE_STATE_ACTIVE');
  assert.equal(decode(3), 'LEASE_STATE_INSUFFICIENT_FUNDS');
  assert.equal(decode(4), 'LEASE_STATE_CLOSED');
});

test('decode() pass-through for canonical string', () => {
  assert.equal(decode('LEASE_STATE_ACTIVE'), 'LEASE_STATE_ACTIVE');
  assert.equal(decode('LEASE_STATE_PENDING'), 'LEASE_STATE_PENDING');
});

test('decode() returns undefined for unknown integer', () => {
  assert.equal(decode(99), undefined);
  assert.equal(decode(-1), undefined);
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

test('decode() coerces stringy integers (chain emits strings sometimes)', () => {
  assert.equal(decode('2'), 'LEASE_STATE_ACTIVE');
});

test('isTerminal flags CLOSED and INSUFFICIENT_FUNDS', () => {
  assert.equal(isTerminal('LEASE_STATE_CLOSED'), true);
  // Documented gotcha: close_lease can leave the lease in INSUFFICIENT_FUNDS
  // (with closedAt populated) rather than CLOSED. Skills that gate on
  // CLOSED-only would orphan the saved manifest.
  assert.equal(isTerminal('LEASE_STATE_INSUFFICIENT_FUNDS'), true);
});

test('isTerminal does NOT flag PENDING or ACTIVE', () => {
  assert.equal(isTerminal('LEASE_STATE_PENDING'), false);
  assert.equal(isTerminal('LEASE_STATE_ACTIVE'), false);
  assert.equal(isTerminal('LEASE_STATE_UNSPECIFIED'), false);
});

test('STATES table covers the full enum range', () => {
  assert.deepEqual(Object.keys(STATES).map(Number).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

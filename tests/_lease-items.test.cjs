'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickLeasesArray, normalizeItem, findLease } = require('../scripts/_lease-items.cjs');

test('pickLeasesArray: accepts {leases: [...]} envelope', () => {
  assert.deepEqual(pickLeasesArray({ leases: [{ uuid: 'a' }] }), [{ uuid: 'a' }]);
});

test('pickLeasesArray: accepts a bare array (legacy shape)', () => {
  assert.deepEqual(pickLeasesArray([{ uuid: 'a' }]), [{ uuid: 'a' }]);
});

test('pickLeasesArray: throws on unrecognized shape', () => {
  assert.throws(() => pickLeasesArray({ foo: 'bar' }), /expected `leases\[\]` array or bare array/);
  assert.throws(() => pickLeasesArray(null), /expected `leases\[\]` array/);
  assert.throws(() => pickLeasesArray('string'), /expected `leases\[\]` array/);
});

test('normalizeItem: handles camelCase keys', () => {
  assert.deepEqual(
    normalizeItem({ serviceName: 'web', customDomain: 'app.example.com' }),
    { serviceName: 'web', customDomain: 'app.example.com' }
  );
});

test('normalizeItem: handles snake_case keys (chain raw shape)', () => {
  assert.deepEqual(
    normalizeItem({ service_name: 'web', custom_domain: 'app.example.com' }),
    { serviceName: 'web', customDomain: 'app.example.com' }
  );
});

test('normalizeItem: defaults missing fields to empty string', () => {
  assert.deepEqual(normalizeItem({}), { serviceName: '', customDomain: '' });
  assert.deepEqual(normalizeItem(null), { serviceName: '', customDomain: '' });
});

test('normalizeItem: camelCase wins when both present', () => {
  // Defensive: should not happen in practice, but caller behavior must be
  // deterministic. The ?? operator picks camelCase first.
  assert.deepEqual(
    normalizeItem({ serviceName: 'cc', service_name: 'sc', customDomain: 'd', custom_domain: 'sd' }),
    { serviceName: 'cc', customDomain: 'd' }
  );
});

test('findLease: case-insensitive UUID match', () => {
  const payload = { leases: [{ uuid: '11111111-1111-4111-8111-111111111111', items: [] }] };
  const lease = findLease(payload, '11111111-1111-4111-8111-111111111111'.toUpperCase());
  assert.ok(lease);
  assert.equal(lease.uuid, '11111111-1111-4111-8111-111111111111');
});

test('findLease: tolerates uuid / lease_uuid / leaseUuid keys', () => {
  const payload = {
    leases: [
      { uuid: '11111111-1111-4111-8111-111111111111' },
      { lease_uuid: '22222222-2222-4222-8222-222222222222' },
      { leaseUuid: '33333333-3333-4333-8333-333333333333' },
    ],
  };
  assert.ok(findLease(payload, '11111111-1111-4111-8111-111111111111'));
  assert.ok(findLease(payload, '22222222-2222-4222-8222-222222222222'));
  assert.ok(findLease(payload, '33333333-3333-4333-8333-333333333333'));
});

test('findLease: returns null when no lease matches', () => {
  const payload = { leases: [{ uuid: '11111111-1111-4111-8111-111111111111' }] };
  assert.equal(findLease(payload, '99999999-9999-4999-8999-999999999999'), null);
});

test('findLease: returns null on empty leases array', () => {
  assert.equal(findLease({ leases: [] }, '11111111-1111-4111-8111-111111111111'), null);
});

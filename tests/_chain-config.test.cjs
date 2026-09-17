'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEndpointUrl, isValidChainId, isValidGasPrice, isValidGasDenom } = require('../scripts/_chain-config.cjs');
const { VECTORS } = require('../ci/chain-config-parity.cjs');

for (const [kind, check] of [
  ['endpoints', value => validateEndpointUrl(value, 'endpoint').valid],
  ['chainIds', isValidChainId], ['gasPrices', isValidGasPrice],
]) {
  test(`config ${kind} predicate matches the pinned string-policy vectors`, () => {
    for (const [value, valid] of VECTORS[kind]) assert.equal(check(value), valid, JSON.stringify(value));
  });
}

test('chain ID and gas-price predicates require strings', () => {
  for (const value of [undefined, null, 42, true, {}, []]) {
    assert.equal(isValidChainId(value), false);
    assert.equal(isValidGasPrice(value), false);
  }
});

test('endpoint diagnostics retain the caller field for malformed URLs and unsupported schemes', () => {
  for (const value of ['not a URL', 'ftp://example.invalid', 'http://example.invalid']) {
    const result = validateEndpointUrl(value, 'apis.rest[0].address');
    assert.equal(result.valid, false);
    assert.match(result.reason, /apis\.rest\[0\]\.address/);
  }
});

test('denom validation preserves the amount/denom boundary and applies consumer grammar', () => {
  for (const denom of ['umfx', 'factory/manifest1.../upwr', 'ibc/ABC123', 'a'.repeat(128)]) assert.equal(isValidGasDenom(denom), true);
  for (const denom of [null, 42, '9mfx', 'umfx\n', 'xy', 'a'.repeat(129), 'factory//upwr']) assert.equal(isValidGasDenom(denom), false);
});

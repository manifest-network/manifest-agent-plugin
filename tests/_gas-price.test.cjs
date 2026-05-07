'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeGasPrice } = require('../scripts/_gas-price.cjs');

const MANIFEST_CHAIN = {
  chainId: 'manifest-ledger-mainnet',
  feeTokens: [
    { denom: 'umfx', symbol: 'MFX', fixedMinGasPrice: 1 },
    { denom: 'factory/manifest1.../upwr', symbol: 'PWR', fixedMinGasPrice: 0.37 },
  ],
};

test('composeGasPrice: composes raw denom (not symbol) for MFX', () => {
  // The whole point of this helper: prevent prose-driven misuse where the
  // symbol "MFX" gets dropped into the gas-price string instead of "umfx".
  assert.equal(composeGasPrice(MANIFEST_CHAIN, 'MFX'), '1umfx');
});

test('composeGasPrice: composes raw denom for factory PWR token', () => {
  assert.equal(composeGasPrice(MANIFEST_CHAIN, 'PWR'), '0.37factory/manifest1.../upwr');
});

test('composeGasPrice: throws on unknown symbol with available list in message', () => {
  assert.throws(
    () => composeGasPrice(MANIFEST_CHAIN, 'BOGUS'),
    /No fee token with symbol "BOGUS".*Available: MFX, PWR/
  );
});

test('composeGasPrice: throws when feeTokens is empty / missing', () => {
  assert.throws(() => composeGasPrice({}, 'MFX'), /No fee token.*Available: \(none\)/);
  assert.throws(() => composeGasPrice({ feeTokens: [] }, 'MFX'), /No fee token.*Available: \(none\)/);
  assert.throws(() => composeGasPrice(null, 'MFX'), /No fee token/);
});

test('composeGasPrice: throws when token is missing fixedMinGasPrice', () => {
  const broken = { feeTokens: [{ denom: 'umfx', symbol: 'MFX' }] };
  assert.throws(() => composeGasPrice(broken, 'MFX'), /missing denom or fixedMinGasPrice/);
});

test('composeGasPrice: throws when token is missing denom', () => {
  const broken = { feeTokens: [{ symbol: 'MFX', fixedMinGasPrice: 1 }] };
  assert.throws(() => composeGasPrice(broken, 'MFX'), /missing denom or fixedMinGasPrice/);
});

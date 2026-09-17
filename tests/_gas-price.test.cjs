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

test('composeGasPrice: rejects unusable cached prices rather than composing nullumfx', () => {
  for (const fixedMinGasPrice of [null, NaN, Infinity, -1, false, '', '1', {}, []]) {
    const chain = { feeTokens: [{ symbol: 'MFX', denom: 'umfx', fixedMinGasPrice }] };
    assert.throws(() => composeGasPrice(chain, 'MFX'), /fixedMinGasPrice must be a finite nonnegative number/);
  }
});

test('composeGasPrice: rejects denominations outside the pinned runtime grammar', () => {
  for (const denom of ['', 'xy', '9mfx', 'umfx\n', 'u/m/f/', 'u'.repeat(129)]) {
    assert.throws(() => composeGasPrice({ feeTokens: [{ symbol: 'MFX', denom, fixedMinGasPrice: 1 }] }, 'MFX'), /denom must be a valid gas denomination/);
  }
});

test('composeGasPrice: emits decimal strings for zero and numeric exponent boundaries', () => {
  for (const [fixedMinGasPrice, expected] of [[0, '0'], [1e-7, '0.0000001'], [1.25e-7, '0.000000125'],
    [1e21, '1000000000000000000000'], [1.25e21, '1250000000000000000000']]) {
    assert.equal(composeGasPrice({ feeTokens: [{ symbol: 'MFX', denom: 'umfx', fixedMinGasPrice }] }, 'MFX'), expected + 'umfx');
  }
});

test('composeGasPrice: a null legacy token does not hide the available-token diagnostic', () => {
  assert.throws(() => composeGasPrice({ feeTokens: [null] }, 'MFX'), /No fee token.*Available: \(none\)/);
});

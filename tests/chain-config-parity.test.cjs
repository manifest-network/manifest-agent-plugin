'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { VECTORS, checkChainConfigParity } = require('../ci/chain-config-parity.cjs');
const predicates = require('../scripts/_chain-config.cjs');

// Simulated upstream results come from reviewed vectors, not copied predicates.
const expected = Object.fromEntries(Object.entries(VECTORS).map(([kind, vectors]) => [kind, new Map(vectors)]));
const upstream = {
  validateEndpointUrl: value => ({ valid: expected.endpoints.get(value) }),
  validateConfig: config => ({ valid: expected.chainIds.get(config.chainId) && expected.gasPrices.get(config.gasPrice) }),
};

test('config parity compares consumer predicates and persisted registry configs', () => {
  assert.equal(checkChainConfigParity(upstream), Object.values(VECTORS).reduce((n, values) => n + values.length, 12));
});

test('config parity fails when upstream endpoint policy tightens or loosens', () => {
  for (const value of ['http://localhost:26657', 'http://rpc.example.invalid']) {
    assert.throws(() => checkChainConfigParity({ ...upstream,
      validateEndpointUrl: url => ({ valid: url === value ? !expected.endpoints.get(url) : expected.endpoints.get(url) }),
    }), /Installed runtime policy changed: endpoints/);
  }
});

test('config parity detects chain-ID and gas-price drift on either side', () => {
  for (const [method, value] of [['isValidChainId', 'manifest.ledger'], ['isValidGasPrice', 'nullumfx']]) {
    assert.throws(() => checkChainConfigParity(upstream, { ...predicates,
      [method]: input => input === value || predicates[method](input),
    }), /Plugin differs from installed runtime/);
  }
  for (const field of ['chainId', 'gasPrice']) {
    assert.throws(() => checkChainConfigParity({ ...upstream,
      validateConfig: config => ({ valid: config[field] === '' || upstream.validateConfig(config).valid }),
    }), /Installed runtime policy changed/);
  }
});

test('config parity fails if saved configs no longer pass startup validation', () => {
  assert.throws(() => checkChainConfigParity({ ...upstream,
    validateConfig: config => config.feeTokens ? { valid: false, errors: ['new startup requirement'] } : upstream.validateConfig(config),
  }), /Persisted registry data rejected at startup/);
});

test('config parity CLI requires an explicit installed runtime and refuses missing packages', t => {
  const data = mkdtempSync(join(tmpdir(), 'chain-config-parity-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  for (const args of [[], ['--data-dir'], ['--data-dir', '--json'], ['--unknown', data], ['--data-dir', data]]) {
    const result = spawnSync(process.execPath, [join(__dirname, '../ci/chain-config-parity.cjs'), ...args], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, args[0] === '--data-dir' && args[1] === data ? /Cannot find module/ : /Usage:/);
  }
});

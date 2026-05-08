'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runScript } = require('./_subprocess.cjs');

const ADDR = 'manifest1exampleaddressxxxxxxxxxxxxxxxxxxxxx';

function withChainData(feeTokens, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'render-balance-test-'));
  const path = join(dir, 'testnet.json');
  writeFileSync(path, JSON.stringify({ feeTokens }), 'utf8');
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FEE_TOKENS = [
  { denom: 'umfx', symbol: 'MFX' },
  { denom: 'factory/manifest1xxx/upwr', symbol: 'PWR' },
];

test('full credit account renders all four lines', () => {
  const payload = {
    credits: { tenant: ADDR },
    balances: [{ denom: 'umfx', amount: '1500000' }],
    current_balance: [{ denom: 'umfx', amount: '500000' }],
    spending_per_hour: [{ denom: 'factory/manifest1xxx/upwr', amount: '1800000' }],
    running_apps: '2',
    hours_remaining: '99.5',
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /### Balance for manifest1exampleaddressxxxxxxxxxxxxxxxxxxxxx/);
    assert.match(r.stdout, /- Wallet: 1\.5 MFX/);
    assert.match(r.stdout, /- Credit balance: 0\.5 MFX/);
    assert.match(r.stdout, /- Burn rate: 1\.8 PWR \/ hour \(running: 2 apps\)/);
    assert.match(r.stdout, /- Hours remaining: ~99\.5/);
  });
});

test('funded credits without active lease falls back to credits.available_balances', () => {
  // Real-world scenario the chain emits when a user has funded their credit
  // account but has no ACTIVE leases yet: `current_balance` is absent (the
  // per-tenant credit estimator skips its computation), but `credits` is
  // populated. render-deployment-plan.cjs already handles this via
  // `current_balance` -> `credits.available_balances` -> `credits.balances`;
  // render-balance.cjs must mirror that chain, otherwise funded users would
  // be mislabeled as having no credit account at all.
  const payload = {
    credits: {
      available_balances: [{ denom: 'umfx', amount: '750000' }],
      balances: [{ denom: 'umfx', amount: '1000000' }],
    },
    balances: [{ denom: 'umfx', amount: '500000' }],
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Credit balance: 0\.75 MFX/);
    // Live estimator fields are not meaningful when sourced from
    // available_balances / balances — they must NOT appear.
    assert.match(r.stdout, /- Burn rate: \(unavailable\)/);
    assert.match(r.stdout, /- Hours remaining: ~\(unavailable\)/);
  });
});

test('credits with only balances (gross funded) falls back further', () => {
  const payload = {
    credits: {
      balances: [{ denom: 'umfx', amount: '2000000' }],
    },
    balances: [],
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Credit balance: 2 MFX/);
  });
});

test('credits exists but every balance array is empty renders "(empty)"', () => {
  const payload = {
    credits: { available_balances: [], balances: [] },
    balances: [],
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Credit balance: \(empty\)/);
    assert.doesNotMatch(r.stdout, /- Credit balance: \(no credit account\)/);
  });
});

test('rejects array stdin (not a JSON object)', () => {
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      '[]',
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expected a JSON object/);
  });
});

test('null credits surfaces "(no credit account)" and "(unavailable)" fallbacks', () => {
  const payload = {
    credits: null,
    balances: [{ denom: 'umfx', amount: '1000000' }],
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Wallet: 1 MFX/);
    assert.match(r.stdout, /- Credit balance: \(no credit account\)/);
    assert.match(r.stdout, /- Burn rate: \(unavailable\) \/ hour \(running: \(unavailable\) apps\)/);
    assert.match(r.stdout, /- Hours remaining: ~\(unavailable\)/);
  });
});

test('multi-denom wallet renders comma-separated', () => {
  const payload = {
    credits: null,
    balances: [
      { denom: 'umfx', amount: '2000000' },
      { denom: 'factory/manifest1xxx/upwr', amount: '750000' },
    ],
  };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Wallet: 2 MFX, 0\.75 PWR/);
  });
});

test('unknown denom falls back to raw amount + denom (chain data file unreadable)', () => {
  const payload = {
    credits: null,
    balances: [{ denom: 'unknown-denom', amount: '12345' }],
  };
  const r = runScript(
    'render-balance.cjs',
    ['--chain-data-file', '/nonexistent/path/chain.json', '--address', ADDR],
    JSON.stringify(payload),
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /- Wallet: 12345 unknown-denom/);
});

test('empty balances array renders "(empty)"', () => {
  const payload = { credits: null, balances: [] };
  withChainData(FEE_TOKENS, (path) => {
    const r = runScript(
      'render-balance.cjs',
      ['--chain-data-file', path, '--address', ADDR],
      JSON.stringify(payload),
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- Wallet: \(empty\)/);
  });
});

test('rejects missing --chain-data-file', () => {
  const r = runScript('render-balance.cjs', ['--address', ADDR], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --chain-data-file/);
});

test('rejects missing --address', () => {
  const r = runScript('render-balance.cjs', ['--chain-data-file', '/tmp/x.json'], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --address/);
});

test('rejects unparseable stdin', () => {
  const r = runScript(
    'render-balance.cjs',
    ['--chain-data-file', '/tmp/x.json', '--address', ADDR],
    'not json',
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});

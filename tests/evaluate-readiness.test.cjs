'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('./_subprocess.cjs');

/**
 * Smallest passing payload — sets up an "ok" baseline that individual tests
 * mutate. Includes wallet gas balance, credits with available_balances, and
 * a SKU at standard price.
 */
function basePayload() {
  return {
    tenant: 'manifest1deadbeef',
    image: 'ghcr.io/me/app:v1',
    size: 'small',
    wallet_balances: [{ denom: 'umfx', amount: '10000000' }], // 10 MFX
    credits: { available_balances: [{ denom: 'umfx', amount: '50000000000' }] }, // 50,000 MFX → many hours at 1k/hr
    sku: { name: 'small', price: { denom: 'umfx', amount: '1000' } },
    available_sku_names: ['small', 'medium'],
  };
}

function evaluate(payload, extraArgs = []) {
  return runScript(
    'evaluate-readiness.cjs',
    ['--gas-price', '1umfx', ...extraArgs],
    JSON.stringify(payload),
  ).json;
}

test('baseline ok payload returns ok status', () => {
  const r = evaluate(basePayload());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.reasons, []);
});

test('empty wallet → block + request_faucet + topup_wallet', () => {
  const p = basePayload();
  p.wallet_balances = [];
  const r = evaluate(p);
  assert.equal(r.status, 'block');
  assert.ok(r.reasons.some((s) => /no .* balance for gas/i.test(s)));
  assert.ok(r.suggested_actions.includes('request_faucet'));
  assert.ok(r.suggested_actions.includes('topup_wallet'));
});

test('zero gas balance → block (not silently ok with stale entry)', () => {
  const p = basePayload();
  p.wallet_balances = [{ denom: 'umfx', amount: '0' }];
  const r = evaluate(p);
  assert.equal(r.status, 'block');
});

test('unavailable SKU → block + pick_different_sku', () => {
  const p = basePayload();
  p.size = 'xxl';
  p.available_sku_names = ['small', 'medium'];
  const r = evaluate(p);
  assert.equal(r.status, 'block');
  assert.ok(r.reasons.some((s) => /not currently offered/.test(s)));
  assert.ok(r.suggested_actions.includes('pick_different_sku'));
});

test('low gas balance below warn floor → warn + topup_wallet', () => {
  const p = basePayload();
  // Default umfx warn floor is 50_000n. Sit just below it.
  p.wallet_balances = [{ denom: 'umfx', amount: '40000' }];
  const r = evaluate(p);
  assert.equal(r.status, 'warn');
  assert.ok(r.suggested_actions.includes('topup_wallet'));
});

test('fresh deployer with available_balances but no current_balance → not falsely flagged', () => {
  // Documented bug-fix from CLAUDE.md / source comments: hours_remaining is 0
  // when the tenant has no active leases (no burn rate). Combined with a
  // legitimate available_balances above the SKU floor, the verdict must be
  // "ok" — not "warn: credits empty".
  const p = basePayload();
  p.hours_remaining = '0';
  delete p.current_balance;
  const r = evaluate(p);
  assert.equal(r.status, 'ok');
});

test('credits funded in different denom than SKU price → specific reason', () => {
  const p = basePayload();
  p.credits = { available_balances: [{ denom: 'upwr', amount: '50000000' }] };
  p.sku = { name: 'small', price: { denom: 'umfx', amount: '1000' } };
  const r = evaluate(p);
  assert.equal(r.status, 'warn');
  assert.ok(r.reasons.some((s) => /no .* balance/i.test(s) && /charges in/.test(s)));
  assert.ok(r.suggested_actions.includes('fund_credit'));
});

test('low SKU runtime (<24h at price) → warn + fund_credit', () => {
  const p = basePayload();
  // 1000 umfx/hr × 12h = 12000 umfx. Below 24h floor.
  p.credits = { available_balances: [{ denom: 'umfx', amount: '12000' }] };
  const r = evaluate(p);
  assert.equal(r.status, 'warn');
  assert.ok(r.reasons.some((s) => /below the 24h floor/.test(s)));
  assert.ok(r.suggested_actions.includes('fund_credit'));
});

test('hours_remaining: 0 with no SKU pricing → does NOT trigger warn', () => {
  // Without sku.price the script falls through to the hours_remaining
  // fallback. Per the comment, hrs > 0 is required to warn — `0` means no
  // active burn, not low credits.
  const p = basePayload();
  delete p.sku;
  p.hours_remaining = '0';
  const r = evaluate(p);
  assert.equal(r.status, 'ok');
});

test('hours_remaining: small positive (<24h) with no SKU → warn', () => {
  const p = basePayload();
  delete p.sku;
  p.hours_remaining = '5';
  const r = evaluate(p);
  assert.equal(r.status, 'warn');
  assert.ok(r.suggested_actions.includes('fund_credit'));
});

test('rejects --gas-price that fails the denom regex (trailing whitespace etc.)', () => {
  const r = runScript('evaluate-readiness.cjs', ['--gas-price', '1umfx '], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must match <numeric><denom>/);
});

test('rejects missing --gas-price', () => {
  const r = runScript('evaluate-readiness.cjs', [], '{}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required flag: --gas-price/);
});

#!/usr/bin/env node
'use strict';

/**
 * Evaluate the response from `mcp__manifest-fred__check_deployment_readiness`
 * and emit a structured verdict on stdout.
 *
 * Input (stdin, JSON object):
 *   {
 *     tenant: string,
 *     image: string | null,
 *     size: string | null,
 *     wallet_balances: [{ denom, amount }, ...],
 *     credits: object | null,
 *     current_balance?: [{ denom, amount }, ...],
 *     hours_remaining?: string,
 *     sku: { name, ..., price?: { amount, denom } } | null,
 *     available_sku_names: [string, ...]
 *   }
 *
 * Output (stdout, single-line JSON):
 *   {
 *     status: "ok" | "warn" | "block",
 *     reasons: [string, ...],
 *     suggested_actions: [string, ...]   // semantic tokens — not prose for the user
 *   }
 *
 * Status semantics:
 *   - "block": cannot proceed (SKU unavailable, wallet empty, etc.)
 *   - "warn":  proceedable but risky (low credits, low gas balance)
 *   - "ok":    silent pass
 *
 * suggested_actions tokens:
 *   - "fund_credit"           — invoke mcp__manifest-lease__fund_credit
 *   - "request_faucet"        — invoke mcp__manifest-chain__request_faucet (testnet)
 *   - "topup_wallet"          — direct user to top up the agent's address (mainnet)
 *   - "pick_different_sku"    — surface available_sku_names as alternatives
 *
 * Skills should branch on `status` and surface the prose-y reasons + map
 * suggested_actions to AskUserQuestion options. Thresholds are encoded here
 * (not in skill prose) so they're consistent across runs.
 */

const { readFileSync } = require('node:fs');

// Tunables — edit here, not in SKILL.md.
const HOURS_REMAINING_WARN_FLOOR = 24;
// Gas balance "below what's needed" — a coarse floor in the chain's smallest unit.
// 1 MFX = 1,000,000 umfx. We warn under 0.05 MFX to leave headroom for a typical tx.
const GAS_DENOM = 'umfx';
const GAS_BALANCE_WARN_FLOOR = 50_000n; // 0.05 MFX

function asBigInt(s) {
  try { return BigInt(s); } catch { return 0n; }
}

(async () => {
  const raw = readFileSync(0, 'utf8');
  let r;
  try {
    r = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (r === null || typeof r !== 'object') {
    console.error('stdin must be a JSON object');
    process.exit(1);
  }

  const reasons = [];
  const actions = new Set();
  let status = 'ok';

  // SKU availability — hard block.
  if (r.size && Array.isArray(r.available_sku_names) && !r.available_sku_names.includes(r.size)) {
    status = 'block';
    reasons.push(`Requested SKU "${r.size}" is not currently offered. Available: ${r.available_sku_names.join(', ') || '(none)'}.`);
    actions.add('pick_different_sku');
  }

  // Wallet gas balance — hard block if absent, warn if low.
  const balances = Array.isArray(r.wallet_balances) ? r.wallet_balances : [];
  const gasEntry = balances.find((b) => b && b.denom === GAS_DENOM);
  const gasAmount = gasEntry ? asBigInt(gasEntry.amount) : 0n;
  if (balances.length === 0 || gasAmount === 0n) {
    if (status !== 'block') status = 'block';
    reasons.push(`Wallet has no ${GAS_DENOM} balance for gas.`);
    actions.add('request_faucet'); // skill chooses faucet vs topup based on chain
    actions.add('topup_wallet');
  } else if (gasAmount < GAS_BALANCE_WARN_FLOOR) {
    if (status === 'ok') status = 'warn';
    reasons.push(`Wallet ${GAS_DENOM} balance (${gasAmount.toString()}) is below ${GAS_BALANCE_WARN_FLOOR.toString()}; broadcast may run out of gas.`);
    actions.add('topup_wallet');
  }

  // Credits — warn if missing or below the hours-remaining floor.
  if (!r.credits) {
    if (status === 'ok') status = 'warn';
    reasons.push('No credit account funded for compute leases.');
    actions.add('fund_credit');
  } else if (r.hours_remaining !== undefined) {
    const hrs = Number(r.hours_remaining);
    if (Number.isFinite(hrs) && hrs < HOURS_REMAINING_WARN_FLOOR) {
      if (status === 'ok') status = 'warn';
      reasons.push(`Credits cover ~${hrs.toFixed(1)}h of runtime at this SKU; below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`);
      actions.add('fund_credit');
    }
  }

  console.log(JSON.stringify({
    status,
    reasons,
    suggested_actions: Array.from(actions),
  }));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

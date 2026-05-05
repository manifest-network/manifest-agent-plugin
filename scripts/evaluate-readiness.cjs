#!/usr/bin/env node
'use strict';

/**
 * Evaluate the response from `mcp__manifest-fred__check_deployment_readiness`
 * and emit a structured verdict on stdout.
 *
 * Args:
 *   --gas-price <price>   The agent's configured gasPrice string from
 *                         $MANIFEST_PLUGIN_DATA/config.json, e.g. "1umfx" or
 *                         "0.37upwr". The denom is parsed out and used for
 *                         the wallet gas-balance check. REQUIRED — without
 *                         it the script cannot tell which wallet entry to
 *                         match for gas (the plugin supports both umfx and
 *                         upwr as fee tokens).
 *   --gas-warn-floor <n>  Optional. Override the warn threshold for low
 *                         gas balance, in the smallest unit of the gas
 *                         denom. Defaults vary per denom (see DEFAULTS).
 *   --chain-data-file <path>  Optional but recommended. Path to the chain
 *                         registry JSON (e.g. $MANIFEST_PLUGIN_DATA/chains/<chain>.json)
 *                         so `reasons[]` render with friendly token
 *                         symbols (MFX / PWR) instead of raw on-chain
 *                         denoms. When omitted, balances stay in raw form.
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
const { loadChainDenomMap, humanizeCoin, denomToSymbol } = require('./humanize-denom.cjs');

// Tunables — edit here, not in SKILL.md.
const HOURS_REMAINING_WARN_FLOOR = 24;
// Per-denom warn floors for low gas balance (in the smallest unit). Numbers
// reflect the chain registry's `fixedMinGasPrice` for each token (umfx=1,
// upwr=0.37 at the time of writing) scaled up to a "few transactions worth".
// Add new denoms here as the plugin grows beyond umfx/upwr.
const GAS_BALANCE_WARN_FLOOR_DEFAULTS = {
  umfx: 50_000n, // 0.05 MFX (1 MFX = 1,000,000 umfx)
  upwr: 50_000n, // ~0.05 PWR; comparable headroom
};
const GAS_BALANCE_WARN_FLOOR_FALLBACK = 50_000n;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--gas-price' && next) { args.gasPrice = next; i++; }
    else if (flag === '--gas-warn-floor' && next) { args.gasWarnFloor = next; i++; }
    else if (flag === '--chain-data-file' && next) { args.chainDataFile = next; i++; }
  }
  return args;
}

function denomFromGasPrice(gasPrice) {
  // Cosmos convention: leading numeric (digits + optional decimal point),
  // then the denom (lowercase alphanumeric, possibly with `/` for IBC).
  const m = /^[0-9.]+(.+)$/.exec(gasPrice);
  return m ? m[1] : null;
}

function asBigInt(s) {
  try { return BigInt(s); } catch { return 0n; }
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.gasPrice) {
    console.error('Missing required flag: --gas-price (e.g. "1umfx" or "0.37upwr")');
    process.exit(1);
  }
  const gasDenom = denomFromGasPrice(args.gasPrice);
  if (!gasDenom) {
    console.error(`--gas-price must match <numeric><denom>, got "${args.gasPrice}"`);
    process.exit(1);
  }

  let gasWarnFloor;
  if (args.gasWarnFloor !== undefined) {
    try {
      gasWarnFloor = BigInt(args.gasWarnFloor);
    } catch {
      console.error(`--gas-warn-floor must be a non-negative integer, got "${args.gasWarnFloor}"`);
      process.exit(1);
    }
    // BigInt("-1") parses successfully as -1n, so the catch above doesn't
    // reject negatives. A negative floor would silently suppress the
    // low-gas warning logic; reject explicitly.
    if (gasWarnFloor < 0n) {
      console.error(`--gas-warn-floor must be a non-negative integer, got "${args.gasWarnFloor}"`);
      process.exit(1);
    }
  } else {
    gasWarnFloor = GAS_BALANCE_WARN_FLOOR_DEFAULTS[gasDenom] ?? GAS_BALANCE_WARN_FLOOR_FALLBACK;
  }

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
  // Optional denom -> symbol map for humanizing reasons. Missing file
  // path is fine — humanizeCoin falls back to "<amount> <denom>".
  const denomMap = loadChainDenomMap(args.chainDataFile);

  // SKU availability — hard block.
  if (r.size && Array.isArray(r.available_sku_names) && !r.available_sku_names.includes(r.size)) {
    status = 'block';
    reasons.push(`Requested SKU "${r.size}" is not currently offered. Available: ${r.available_sku_names.join(', ') || '(none)'}.`);
    actions.add('pick_different_sku');
  }

  // Wallet gas balance — hard block if absent, warn if low. The denom we look
  // for matches whatever the agent is configured to pay gas in; both umfx and
  // upwr are valid per CLAUDE.md.
  const balances = Array.isArray(r.wallet_balances) ? r.wallet_balances : [];
  const gasEntry = balances.find((b) => b && b.denom === gasDenom);
  const gasAmount = gasEntry ? asBigInt(gasEntry.amount) : 0n;
  if (balances.length === 0 || gasAmount === 0n) {
    if (status !== 'block') status = 'block';
    reasons.push(`Wallet has no ${denomToSymbol(gasDenom, denomMap)} balance for gas.`);
    actions.add('request_faucet'); // skill chooses faucet vs topup based on chain
    actions.add('topup_wallet');
  } else if (gasAmount < gasWarnFloor) {
    if (status === 'ok') status = 'warn';
    reasons.push(`Wallet balance (${humanizeCoin(gasAmount.toString(), gasDenom, denomMap)}) is below ${humanizeCoin(gasWarnFloor.toString(), gasDenom, denomMap)}; broadcast may run out of gas.`);
    actions.add('topup_wallet');
  }

  // Credits — warn if missing or low against the chosen SKU.
  //
  // Important: the MCP's `hours_remaining` is the chain's estimate of runtime
  // at the user's CURRENT overall burn rate (sum of active leases). It is
  // NOT specific to the chosen SKU and returns 0 when the user has no
  // active leases — which would falsely flag a well-funded user about to
  // deploy their first app. Compute the per-SKU answer ourselves from the
  // credit balance + sku.price.
  if (!r.credits) {
    if (status === 'ok') status = 'warn';
    reasons.push('No credit account funded for compute leases.');
    actions.add('fund_credit');
  } else if (r.sku && r.sku.price && r.sku.price.amount && r.sku.price.denom) {
    const skuPrice = r.sku.price;
    const creditBalances = Array.isArray(r.current_balance) ? r.current_balance : [];
    const creditEntry = creditBalances.find((b) => b && b.denom === skuPrice.denom);
    const pricePerHour = asBigInt(skuPrice.amount);
    if (creditEntry === undefined) {
      // The credit account has no entry in the SKU's price denom. This is
      // distinct from "credits ran out" — it usually means credits are in
      // a different denom than the SKU charges in (e.g. credits funded in
      // upwr but the SKU prices in umfx, or vice-versa). Emit a specific
      // diagnostic so the user knows to fund_credit in the right denom
      // rather than seeing a false "0 hours of runtime" warning.
      const fundedDenoms = creditBalances.map((b) => b && b.denom).filter(Boolean);
      // Humanize the SKU denom for the user-facing message (e.g.
      // "factory/.../upwr" -> "PWR"); fall back to the raw denom when
      // the symbol map isn't available.
      const skuSymbol = (denomMap.lookup(skuPrice.denom) || {}).symbol || skuPrice.denom;
      const fundedSymbols = fundedDenoms.map((d) => (denomMap.lookup(d) || {}).symbol || d);
      if (status === 'ok') status = 'warn';
      reasons.push(
        fundedDenoms.length > 0
          ? `Credit account has no ${skuSymbol} balance (the ${r.sku.name} SKU charges in ${skuSymbol}; account holds ${fundedSymbols.join(', ')}). Fund ${skuSymbol} credits before deploying.`
          : `Credit account is empty for the ${r.sku.name} SKU's ${skuSymbol} denom. Fund ${skuSymbol} credits before deploying.`,
      );
      actions.add('fund_credit');
    } else if (pricePerHour > 0n) {
      const creditAmount = asBigInt(creditEntry.amount);
      // Convert via Number for the human-readable hours figure. Credit
      // amounts are in the chain's smallest unit and bounded well below
      // Number.MAX_SAFE_INTEGER for any realistic balance.
      const hrsForThisSku = Number(creditAmount) / Number(pricePerHour);
      if (hrsForThisSku < HOURS_REMAINING_WARN_FLOOR) {
        if (status === 'ok') status = 'warn';
        reasons.push(`Credits cover ~${hrsForThisSku.toFixed(1)}h of runtime at the ${r.sku.name} SKU (${humanizeCoin(creditAmount.toString(), skuPrice.denom, denomMap)} / ${humanizeCoin(pricePerHour.toString(), skuPrice.denom, denomMap)} per hour); below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`);
        actions.add('fund_credit');
      }
    }
  } else if (r.hours_remaining !== undefined) {
    // Fallback for cases where SKU pricing is not available in the readiness
    // response (e.g. caller didn't pass --size). Use the chain's
    // hours_remaining but only warn when it's a meaningful positive number
    // below the floor — `0` here means "no current burn", not "low credits".
    const hrs = Number(r.hours_remaining);
    if (Number.isFinite(hrs) && hrs > 0 && hrs < HOURS_REMAINING_WARN_FLOOR) {
      if (status === 'ok') status = 'warn';
      reasons.push(`Credits cover ~${hrs.toFixed(1)}h of runtime at the current burn rate; below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`);
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

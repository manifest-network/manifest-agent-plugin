#!/usr/bin/env node
'use strict';

/**
 * Render a `credit_balance` MCP response as a human-readable Markdown
 * block. The MCP tool returns wallet balances + (optional) credit
 * account state. This script humanizes the on-chain denoms via
 * `humanize-denom.cjs` and pins the line layout so adjacent runs can't
 * disagree on which fields show up.
 *
 * Stdin (JSON object): the raw `credit_balance` response.
 *
 * Args:
 *   --chain-data-file <path>  required. The active chain's
 *                             `$MANIFEST_PLUGIN_DATA/chains/<chain>.json`
 *                             file — used by humanize-denom to map
 *                             on-chain denoms to display symbols.
 *   --address <bech32>        required. The address being reported on
 *                             (echoed in the heading; the MCP response
 *                             doesn't carry it back).
 *
 * Output (stdout, Markdown): a heading line plus four bullet rows, one
 * per credit-account dimension. The exact layout:
 *
 *   ### Balance for <address>
 *   - Wallet: <humanized balances list, or "(empty)">
 *   - Credit balance: <humanized | "(no credit account)" | "(empty)">
 *   - Burn rate: <humanized spending_per_hour> / hour (running: <n> apps)
 *   - Hours remaining: ~<hours_remaining>
 *
 * Credit-balance fallback chain (mirrors `render-deployment-plan.cjs`'s
 * `fmtCredits` to keep the two renderers in sync — a freshly-funded
 * tenant with no ACTIVE leases otherwise gets mislabeled "(no credit
 * account)" because the chain only emits `current_balance` when the
 * per-tenant credit estimator has live leases to compute against):
 *
 *   1. `payload.current_balance`  (live estimator output; only present
 *      when the user has at least one ACTIVE lease)
 *   2. `payload.credits.available_balances`  (funded minus reserved)
 *   3. `payload.credits.balances`  (gross funded)
 *
 * `(no credit account)` is reserved STRICTLY for `credits == null/undefined`.
 * If the credit account exists but every fallback array is empty/absent,
 * the credit-balance line renders `(empty)` instead.
 *
 * Burn rate / running_apps / hours_remaining are part of the same
 * per-tenant estimator output as `current_balance`, so they are
 * meaningful only when the credit-balance source is `'current'`. When
 * we fall back to `available_balances` / `balances`, those three lines
 * render `(unavailable)` — the chain does not emit them in that case
 * (and `hours_remaining: 0` from a no-active-leases tenant would
 * mislead users into thinking their funded credits expire immediately).
 *
 * Exit codes: 0 success; 1 bad args / unparseable stdin / unrecognized shape.
 */

const { readFileSync } = require('node:fs');
const { loadChainDenomMap, humanizeBalances } = require('./humanize-denom.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain-data-file' && argv[i + 1]) { args.chainDataFile = argv[++i]; }
    else if (argv[i] === '--address' && argv[i + 1]) { args.address = argv[++i]; }
  }
  return args;
}

function pickCreditBalance(payload) {
  const c = payload.credits;
  if (c === null || c === undefined) return { value: null, source: 'none' };

  let balances = Array.isArray(payload.current_balance) && payload.current_balance.length > 0
    ? payload.current_balance
    : null;
  if (balances) return { value: balances, source: 'current' };

  balances = Array.isArray(c.available_balances) && c.available_balances.length > 0
    ? c.available_balances
    : null;
  if (balances) return { value: balances, source: 'available' };

  balances = Array.isArray(c.balances) && c.balances.length > 0
    ? c.balances
    : null;
  if (balances) return { value: balances, source: 'funded' };

  return { value: null, source: 'empty' };
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.chainDataFile) {
    console.error('Missing required flag: --chain-data-file');
    process.exit(1);
  }
  if (!args.address) {
    console.error('Missing required flag: --address');
    process.exit(1);
  }

  const raw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`stdin is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.error('expected a JSON object on stdin');
    process.exit(1);
  }

  const denomMap = loadChainDenomMap(args.chainDataFile);

  const wallet = humanizeBalances(payload.balances, denomMap);

  const credit = pickCreditBalance(payload);
  let creditBalance;
  if (credit.source === 'none') creditBalance = '(no credit account)';
  else if (credit.source === 'empty') creditBalance = '(empty)';
  else creditBalance = humanizeBalances(credit.value, denomMap);

  // Live estimator fields (spending_per_hour, running_apps, hours_remaining)
  // are part of the SAME response slice as `current_balance` — only meaningful
  // when the credit balance is sourced from there. Fallback paths produce a
  // useful credit-balance number but no live runway data.
  const isLive = credit.source === 'current';

  const burnRate = isLive && Array.isArray(payload.spending_per_hour)
    ? humanizeBalances(payload.spending_per_hour, denomMap)
    : '(unavailable)';

  const runningApps = isLive && typeof payload.running_apps === 'string'
    ? payload.running_apps
    : '(unavailable)';

  const hoursRemaining = isLive && typeof payload.hours_remaining === 'string'
    ? payload.hours_remaining
    : '(unavailable)';

  const lines = [
    `### Balance for ${args.address}`,
    `- Wallet: ${wallet}`,
    `- Credit balance: ${creditBalance}`,
    `- Burn rate: ${burnRate} / hour (running: ${runningApps} apps)`,
    `- Hours remaining: ~${hoursRemaining}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

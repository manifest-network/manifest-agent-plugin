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
 * Output (stdout, Markdown, fixed shape):
 *   ### Balance for <address>
 *   - Wallet: <humanized balances list, or "(empty)">
 *   - Credit balance: <humanized current_balance | "(no credit account)">
 *   - Burn rate: <humanized spending_per_hour> / hour (running: <n> apps)
 *   - Hours remaining: ~<hours_remaining>
 *
 * Missing optional fields render as `(unavailable)`. When `credits` is
 * null or absent, "Credit balance:" surfaces `(no credit account)` and
 * the burn-rate / hours-remaining lines fall back to `(unavailable)`.
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

  if (!payload || typeof payload !== 'object') {
    console.error('expected a JSON object on stdin');
    process.exit(1);
  }

  const denomMap = loadChainDenomMap(args.chainDataFile);

  const wallet = humanizeBalances(payload.balances, denomMap);

  const hasCreditAccount = payload.credits !== null && payload.credits !== undefined;
  const creditBalance = hasCreditAccount && Array.isArray(payload.current_balance)
    ? humanizeBalances(payload.current_balance, denomMap)
    : '(no credit account)';

  const burnRate = hasCreditAccount && Array.isArray(payload.spending_per_hour)
    ? humanizeBalances(payload.spending_per_hour, denomMap)
    : '(unavailable)';

  const runningApps = hasCreditAccount && typeof payload.running_apps === 'string'
    ? payload.running_apps
    : '(unavailable)';

  const hoursRemaining = hasCreditAccount && typeof payload.hours_remaining === 'string'
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

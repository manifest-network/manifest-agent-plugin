#!/usr/bin/env node
'use strict';

/**
 * Render a `cosmos_estimate_fee` fee.amount array as a single human-readable
 * string for textual confirmation prompts (e.g. "0.0023 MFX").
 *
 * Pins the format that would otherwise be paraphrased by the LLM at every
 * fee-confirmation site (deploy-app, author-manifest fund-credit,
 * troubleshoot-deployment close_lease, manage-domain set/clear). Drift
 * here is invisible until two adjacent prompts in the same flow disagree
 * on rounding or the symbol form; pinning to the same humanizeCoin() that
 * `evaluate-readiness.cjs` and `render-deployment-plan.cjs` use guarantees
 * a single source of truth.
 *
 * Usage:
 *   node humanize-fee.cjs \
 *     --chain-data-file $MANIFEST_PLUGIN_DATA/chains/testnet.json \
 *     --fee-json '[{"denom":"umfx","amount":"2300"}]'
 *
 *   # Or pipe via stdin (omit --fee-json):
 *   echo '[{"denom":"umfx","amount":"2300"}]' | \
 *     node humanize-fee.cjs --chain-data-file $MANIFEST_PLUGIN_DATA/chains/testnet.json
 *
 * Output (stdout, single line):
 *   "0.0023 MFX"                 // single-coin fee
 *   "0.0023 MFX, 100 upwr"       // multi-coin fee (rare; joined with ", ")
 *   "(empty)"                    // empty array
 *
 * Exit codes:
 *   0  success
 *   1  bad args / unparseable fee JSON / unreadable chain-data file
 */

const { readFileSync } = require('node:fs');
const { humanizeBalances, loadChainDenomMap } = require('./humanize-denom.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--chain-data-file' && argv[i + 1]) { args.chainDataFile = argv[++i]; }
    else if (argv[i] === '--fee-json' && argv[i + 1]) { args.feeJson = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.chainDataFile) {
    console.error('Missing required flag: --chain-data-file');
    process.exit(1);
  }

  let raw;
  if (args.feeJson !== undefined) {
    raw = args.feeJson;
  } else {
    raw = readFileSync(0, 'utf8').trim();
    if (!raw) {
      console.error('No fee JSON provided (pass --fee-json or pipe via stdin)');
      process.exit(1);
    }
  }

  let fee;
  try {
    fee = JSON.parse(raw);
  } catch (err) {
    console.error(`Fee JSON is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(fee)) {
    console.error('Fee JSON must be an array of {denom, amount} objects');
    process.exit(1);
  }

  const denomMap = loadChainDenomMap(args.chainDataFile);
  console.log(humanizeBalances(fee, denomMap));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

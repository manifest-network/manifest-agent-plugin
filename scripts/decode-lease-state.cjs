#!/usr/bin/env node
'use strict';

/**
 * Decode a Cosmos LeaseState integer or JSON-encoded string to its canonical
 * `LEASE_STATE_*` name.
 *
 * The MCP tools sometimes return the integer (e.g. `state: 2`) and sometimes
 * return the JSON-encoded string (e.g. `state: "LEASE_STATE_ACTIVE"`),
 * depending on encoding paths. This script normalizes both.
 *
 * Embedded table avoids forcing the LLM to recall enum mappings, which is a
 * known hallucination source for chain-specific enums.
 *
 * Usage:
 *   node decode-lease-state.cjs --state 2
 *   node decode-lease-state.cjs --state LEASE_STATE_ACTIVE
 *
 * Output (stdout, single line): the canonical name, or "UNKNOWN" if the
 * input does not match any known state.
 */

const STATES = {
  0: 'LEASE_STATE_UNSPECIFIED',
  1: 'LEASE_STATE_PENDING',
  2: 'LEASE_STATE_ACTIVE',
  3: 'LEASE_STATE_INSUFFICIENT_FUNDS',
  4: 'LEASE_STATE_CLOSED',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--state' && argv[i + 1]) { args.state = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.state === undefined) {
    console.error('Missing required flag: --state');
    process.exit(1);
  }

  // Input may already be the canonical name; pass through if so.
  if (typeof args.state === 'string' && args.state.startsWith('LEASE_STATE_')) {
    console.log(args.state);
    return;
  }

  const n = Number(args.state);
  if (!Number.isInteger(n) || !(n in STATES)) {
    console.log('UNKNOWN');
    return;
  }
  console.log(STATES[n]);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

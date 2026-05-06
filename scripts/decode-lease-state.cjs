#!/usr/bin/env node
'use strict';

/**
 * Decode a Cosmos LeaseState integer or JSON-encoded string to its canonical
 * `LEASE_STATE_*` name, plus a `terminal` flag callers can use to decide
 * whether the lease is past the point where any further state transitions
 * are possible (i.e. safe to clean up local artifacts).
 *
 * The MCP tools sometimes return the integer (e.g. `state: 2`) and sometimes
 * return the JSON-encoded string (e.g. `state: "LEASE_STATE_ACTIVE"`),
 * depending on encoding paths. This script normalizes both.
 *
 * Wraps the shared `_lease-state.cjs` table behind a CLI so prose paths
 * can decode without a `require`. The table itself lives in
 * `_lease-state.cjs` (single source of truth across consumers); this
 * script is a thin entry point. Centralizing the table avoids forcing
 * the LLM to recall enum mappings — a known hallucination source for
 * chain-specific enums.
 *
 * Terminal states: `LEASE_STATE_CLOSED` AND `LEASE_STATE_INSUFFICIENT_FUNDS`.
 * The chain transitions a lease through INSUFFICIENT_FUNDS when its credit
 * reservation runs out OR when close_lease is invoked manually (observed
 * post-broadcast: a successful close-lease tx may leave the lease in
 * INSUFFICIENT_FUNDS state with `closedAt` populated, rather than directly
 * in CLOSED). Skills that gate cleanup on "state == CLOSED only" miss this
 * case and orphan the local saved-manifest record. Treat both as terminal.
 *
 * Usage:
 *   node decode-lease-state.cjs --state 2
 *   node decode-lease-state.cjs --state LEASE_STATE_ACTIVE
 *   node decode-lease-state.cjs --state 3 --json
 *
 * Output (stdout):
 *   default:  the canonical name on a single line, or "UNKNOWN".
 *   --json:   `{"name":"LEASE_STATE_…","terminal":bool}` on a single line.
 */

const { decode, isTerminal } = require('./_lease-state.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--state' && argv[i + 1]) { args.state = argv[++i]; }
    else if (argv[i] === '--json') { args.json = true; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.state === undefined) {
    console.error('Missing required flag: --state');
    process.exit(1);
  }

  const name = decode(args.state) || 'UNKNOWN';
  if (args.json) {
    console.log(JSON.stringify({ name, terminal: isTerminal(name) }));
  } else {
    console.log(name);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

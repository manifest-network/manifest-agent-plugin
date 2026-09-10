'use strict';

/**
 * Manifest billing v1 LeaseState enum table + decode helpers, shared across
 * scripts. Matches manifestjs's dist/codegen/liftedinit/billing/v1/types.js.
 *
 * Terminal states: CLOSED (normal closure and final settlement), REJECTED
 * (provider rejected the lease), and EXPIRED (a PENDING lease timed out
 * awaiting provider acknowledgement). Rejected and expired leases return
 * their locked credit to the tenant.
 *
 * INSUFFICIENT_FUNDS is no longer in the chain enum. Its legacy string is
 * retained as terminal defensively; no current numeric state maps to it.
 */

const STATES = {
  0: 'LEASE_STATE_UNSPECIFIED',
  1: 'LEASE_STATE_PENDING',
  2: 'LEASE_STATE_ACTIVE',
  3: 'LEASE_STATE_CLOSED',
  4: 'LEASE_STATE_REJECTED',
  5: 'LEASE_STATE_EXPIRED',
};

const TERMINAL_STATES = new Set([
  'LEASE_STATE_CLOSED',
  'LEASE_STATE_REJECTED',
  'LEASE_STATE_EXPIRED',
  'LEASE_STATE_INSUFFICIENT_FUNDS',
]);

// Decode integer-or-string to canonical "LEASE_STATE_*". Returns undefined
// for unrecognized input so callers can distinguish "no info" from a literal
// UNKNOWN sentinel. Wrap with || 'UNKNOWN' when you need the sentinel form.
function decode(state) {
  if (typeof state === 'string' && state.startsWith('LEASE_STATE_')) return state;
  const n = Number(state);
  if (Number.isInteger(n) && n in STATES) return STATES[n];
  return undefined;
}

function isTerminal(name) {
  return TERMINAL_STATES.has(name);
}

module.exports = { STATES, TERMINAL_STATES, decode, isTerminal };

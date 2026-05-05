'use strict';

/**
 * Canonical Cosmos LeaseState enum table + decode helpers, shared across
 * scripts. Single source of truth for the integer ↔ name mapping.
 *
 * Terminal states: a lease in CLOSED or INSUFFICIENT_FUNDS will not
 * transition further. The chain transitions a lease through
 * INSUFFICIENT_FUNDS when its credit reservation runs out OR when
 * close_lease is invoked manually (a successful close-lease tx may leave
 * the lease in INSUFFICIENT_FUNDS with `closedAt` populated, rather than
 * directly in CLOSED). Skills that gate cleanup on "state == CLOSED only"
 * miss this case and orphan the local saved-manifest record.
 */

const STATES = {
  0: 'LEASE_STATE_UNSPECIFIED',
  1: 'LEASE_STATE_PENDING',
  2: 'LEASE_STATE_ACTIVE',
  3: 'LEASE_STATE_INSUFFICIENT_FUNDS',
  4: 'LEASE_STATE_CLOSED',
};

const TERMINAL_STATES = new Set([
  'LEASE_STATE_INSUFFICIENT_FUNDS',
  'LEASE_STATE_CLOSED',
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

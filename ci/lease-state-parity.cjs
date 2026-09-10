#!/usr/bin/env node
'use strict';

// Check the installed SDK after runtime setup, without adding runtime
// dependencies to the unit suite. Usage: --data-dir <runtime-dir>.
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { STATES } = require('../scripts/_lease-state.cjs');

function checkLeaseStateParity(leaseState, states = STATES) {
  // TypeScript enums contain reverse name entries. Exclude those and the
  // SDK's UNRECOGNIZED = -1 sentinel from the chain state table.
  const expected = Object.fromEntries(Object.entries(leaseState)
    .filter(([name, value]) => name !== 'UNRECOGNIZED' && Number.isInteger(value))
    .map(([name, value]) => [value, name]));
  const count = Object.keys(expected).length;
  assert.notEqual(count, 0, 'Installed manifestjs LeaseState contains no numeric chain states');
  assert.deepEqual(states, expected, 'Plugin STATES differs from installed manifestjs LeaseState');
  return count;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: node ci/lease-state-parity.cjs --data-dir <runtime-dir>');
  }
  const sdkPath = join(resolve(args[1]), 'node_modules', '@manifest-network', 'manifestjs',
    'dist', 'codegen', 'liftedinit', 'billing', 'v1', 'types.js');
  const { LeaseState } = require(sdkPath);
  const count = checkLeaseStateParity(LeaseState);
  console.log(`lease-state-parity: OK — ${count} numeric states match installed manifestjs`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`lease-state-parity: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkLeaseStateParity };

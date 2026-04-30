#!/usr/bin/env node
'use strict';

/**
 * Remove a saved manifest at ~/.manifest-agent/manifests/<lease_uuid>.json.
 *
 * Called after a successful close_lease (by /deploy-app failure branch and
 * troubleshoot-deployment) so the manifests dir tracks active leases.
 *
 * No-op + zero-exit if the file does not exist (close_lease may be called for
 * a lease the agent never deployed itself, or the file may already be gone).
 *
 * Usage:
 *   node remove-manifest.cjs --lease-uuid <uuid>
 */

const { existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const MANIFESTS_DIR = join(homedir(), '.manifest-agent', 'manifests');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--lease-uuid' && argv[i + 1]) { args.leaseUuid = argv[++i]; }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.leaseUuid) {
    console.error('Missing required flag: --lease-uuid');
    process.exit(1);
  }

  const path = join(MANIFESTS_DIR, `${args.leaseUuid}.json`);
  if (!existsSync(path)) {
    console.log('noop');
    return;
  }

  unlinkSync(path);
  console.log('removed');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

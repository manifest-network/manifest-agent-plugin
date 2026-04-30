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

const { unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const MANIFESTS_DIR = join(homedir(), '.manifest-agent', 'manifests');
// Strict UUID pattern. Rejecting anything else prevents a `lease_uuid`
// containing `..` or path separators from unlinking arbitrary files outside
// MANIFESTS_DIR (e.g. ~/.manifest-agent/config.json).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (!UUID_RE.test(args.leaseUuid)) {
    console.error(`--lease-uuid must be a UUID; got "${args.leaseUuid}"`);
    process.exit(1);
  }

  const path = join(MANIFESTS_DIR, `${args.leaseUuid}.json`);
  // unlinkSync directly rather than existsSync + unlinkSync — eliminates the
  // TOCTOU window where the file could disappear between the two calls.
  // ENOENT is the documented "file already gone" case and maps to no-op.
  try {
    unlinkSync(path);
    console.log('removed');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('noop');
      return;
    }
    throw err;
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

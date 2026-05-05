#!/usr/bin/env node
'use strict';

/**
 * Remove the saved manifest wrapper for an explicitly closed lease
 * ($MANIFEST_PLUGIN_DATA/manifests/<lease_uuid>.json).
 *
 * Called after a successful close_lease by deploy-app's failure branch
 * and by troubleshoot-deployment. NOT called for naturally-expired
 * leases — those keep their wrapper as a historical record. The
 * manifests dir is therefore "leases the agent has explicit reason to
 * track", not "currently active leases".
 *
 * No-op + zero-exit if the file does not exist (close_lease may target a
 * lease the agent never deployed itself, or a previous removal already
 * cleared the file).
 *
 * Usage:
 *   node remove-manifest.cjs --lease-uuid <uuid>
 */

const { unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { getDataDir } = require('./_io.cjs');
const { UUID_RE } = require('./_uuid.cjs');

const MANIFESTS_DIR = join(getDataDir(), 'manifests');

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

  const manifestPath = join(MANIFESTS_DIR, `${args.leaseUuid}.json`);
  // unlinkSync directly rather than existsSync + unlinkSync — eliminates the
  // TOCTOU window where the file could disappear between the two calls.
  // ENOENT is the documented "file already gone" case and maps to no-op.
  try {
    unlinkSync(manifestPath);
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

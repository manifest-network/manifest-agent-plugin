#!/usr/bin/env node
'use strict';

/**
 * Print a redacted structural summary of a saved manifest wrapper at
 * ~/.manifest-agent/manifests/<lease_uuid>.json.
 *
 * The inner `manifest_json` field can contain user-supplied env values that
 * may be sensitive. This script prints only:
 *   - non-sensitive wrapper fields (image, size, deployed_at_iso, chain_id, etc.)
 *   - structural counts of the manifest (service count, port count)
 *   - environment variable KEYS (never values)
 *
 * Used by troubleshoot-deployment's "Saved manifest" appendix so skills don't
 * have to surface raw manifest_json content.
 *
 * Usage:
 *   node summarize-manifest.cjs --lease-uuid <uuid>
 *
 * Output: human-readable text on stdout (NOT JSON — meant to be pasted into
 * a Markdown report). On missing file: "(no saved manifest for <uuid>)" + exit 0.
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const MANIFESTS_DIR = join(homedir(), '.manifest-agent', 'manifests');
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
  if (!existsSync(path)) {
    console.log(`(no saved manifest for ${args.leaseUuid})`);
    return;
  }

  let wrapper;
  try {
    wrapper = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`(saved manifest for ${args.leaseUuid} is unreadable: ${err.message})`);
    return;
  }

  const lines = [];
  lines.push(`Lease UUID:       ${wrapper.lease_uuid || args.leaseUuid}`);
  if (wrapper.image)           lines.push(`Image:            ${wrapper.image}`);
  if (wrapper.size)            lines.push(`Size:             ${wrapper.size}`);
  if (wrapper.deployed_at_iso) lines.push(`Deployed at:      ${wrapper.deployed_at_iso}`);
  if (wrapper.chain_id)        lines.push(`Chain:            ${wrapper.chain_id}`);
  if (wrapper.meta_hash_hex)   lines.push(`meta_hash_hex:    ${wrapper.meta_hash_hex}`);
  else if (wrapper.meta_hash)  lines.push(`meta_hash:        ${wrapper.meta_hash}`);
  if (wrapper.format)          lines.push(`Format:           ${wrapper.format}`);
  if (wrapper.schema_version)  lines.push(`Schema version:   ${wrapper.schema_version}`);

  // Structural summary of manifest_json — counts only, env KEYS only.
  let manifestObj = null;
  if (wrapper.manifest_json) {
    try {
      manifestObj = typeof wrapper.manifest_json === 'string'
        ? JSON.parse(wrapper.manifest_json)
        : wrapper.manifest_json;
    } catch {
      // ignore — print what we have
    }
  }

  if (manifestObj && typeof manifestObj === 'object' && !Array.isArray(manifestObj)) {
    const services = manifestObj.services && typeof manifestObj.services === 'object' && !Array.isArray(manifestObj.services)
      ? Object.entries(manifestObj.services)
      : [['<root>', manifestObj]];

    let portCount = 0;
    const envKeys = new Set();
    for (const [, svc] of services) {
      if (!svc || typeof svc !== 'object') continue;
      if (svc.ports && typeof svc.ports === 'object') portCount += Object.keys(svc.ports).length;
      if (typeof svc.port === 'number') portCount += 1;
      if (svc.env && typeof svc.env === 'object') {
        for (const k of Object.keys(svc.env)) envKeys.add(k);
      }
      if (svc.environment && typeof svc.environment === 'object') {
        for (const k of Object.keys(svc.environment)) envKeys.add(k);
      }
    }

    lines.push('');
    lines.push('Manifest structure:');
    lines.push(`  Services:        ${services.length}`);
    lines.push(`  Ports exposed:   ${portCount}`);
    lines.push(`  Env entries:     ${envKeys.size}`);
    if (envKeys.size > 0) {
      lines.push(`  Env keys:        ${Array.from(envKeys).sort().join(', ')}`);
    }
    lines.push('');
    lines.push('(Env *values* are intentionally redacted — they may contain secrets.)');
  }

  console.log(lines.join('\n'));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
